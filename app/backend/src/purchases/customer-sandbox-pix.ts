import type {OzavClient, OzavTransfer} from "../providers/ozav-client.js";
import {onboardingExternalRef} from "../onboarding/submission-types.js";

export class CustomerPixError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export interface PixContext {
  purchaseId: string; providerCustomerId: string; providerQuoteId: string;
  amountBrl: string; walletAddress: string;
}
export interface CustomerPixRecord extends PixContext {
  id: string; customerId: string; requestId: string; providerWalletId: string;
  attempted: boolean; simulationAttempted: boolean; transferId: string | null; observation: OzavTransfer | null;
}
export interface CustomerPixRepository {
  context(customerId: string, purchaseId: string): Promise<PixContext | null>;
  findRequest(customerId: string, requestId: string): Promise<CustomerPixRecord | null>;
  read(customerId: string, id: string): Promise<CustomerPixRecord | null>;
  reserve(customerId: string, requestId: string, context: PixContext, walletId: string): Promise<CustomerPixRecord>;
  claim(id: string): Promise<boolean>;
  claimSimulation(row: CustomerPixRecord): Promise<boolean>;
  bind(row: CustomerPixRecord, transferId: string): Promise<void>;
  save(row: CustomerPixRecord, transfer: OzavTransfer): Promise<CustomerPixRecord>;
}
type Provider = Pick<OzavClient, "getCustomerCapabilities" | "getSandboxCustomerSnapshot" | "getCustomerManagedWallet" |
  "createCustomerPixTransfer" | "findCustomerPixTransfer" | "getTransfer" | "simulateCustomerPixPayment">;
const cents = (value: string) => {
  if (!/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value)) throw new CustomerPixError("PIX_PROVIDER_CONTEXT_MISMATCH");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
};
export function validatePixTransfer(row: Pick<CustomerPixRecord, "providerCustomerId" | "providerQuoteId" | "transferId" | "providerWalletId" | "amountBrl">, t: OzavTransfer) {
  if (t.customerId !== row.providerCustomerId || t.quoteId !== row.providerQuoteId || (row.transferId && t.id !== row.transferId)
    || t.source.type !== "fiat_payment" || t.source.currency !== "BRL" || t.source.rail !== "pix"
    || t.destination.type !== "wallet" || t.destination.walletId !== row.providerWalletId
    || t.amounts.source.currency !== "BRL" || cents(t.amounts.source.amount) !== cents(row.amountBrl)
    || t.amounts.target.currency !== "USDT" || !/^\d+(\.\d{1,6})?$/.test(t.amounts.target.amount)
    || Number(t.amounts.target.amount) <= 0
    || !["awaiting_payment", "payment_confirmed", "converting", "payout_initiated", "completed", "failed", "cancelled", "expired", "needs_review", "awaiting_approval"].includes(t.status)) {
    throw new CustomerPixError("PIX_PROVIDER_CONTEXT_MISMATCH");
  }
  if (t.status === "awaiting_payment" && !t.source.paymentInstructions) throw new CustomerPixError("PIX_INSTRUCTIONS_MISSING");
}
export function pixView(row: CustomerPixRecord) {
  const t = row.observation, instructions = t?.source.paymentInstructions;
  const payable = !row.simulationAttempted && t?.status === "awaiting_payment" && instructions && Date.parse(instructions.expiresAt) > Date.now();
  return {id: row.id, purchase_intent_id: row.purchaseId, request_id: row.requestId,
    state: t?.status ?? (row.attempted ? "uncertain" : "reserved"), environment: "test",
    source: {currency: "BRL", amount: row.amountBrl},
    funding_destination: {type: "provider_managed_wallet"},
    subsequent_delivery: {wallet_address: row.walletAddress, proof_network: "solana:devnet", started: false},
    payment_instructions: payable ? {br_code: instructions.brCode, qr_code_image: instructions.qrCodeImage, expires_at: instructions.expiresAt} : null,
    simulation_attempted: row.simulationAttempted,
    source_leg_status: t?.sourceLegStatus ?? null, destination_leg_status: t?.destinationLegStatus ?? null,
    payment_confirmed: t?.sourceLegStatus === "completed" && ["payment_confirmed", "converting", "payout_initiated", "completed"].includes(t.status),
    custody_conversion_completed: t?.status === "completed" && t.sourceLegStatus === "completed" && t.destinationLegStatus === "completed",
    recovery_required: (row.attempted && !t) || (row.simulationAttempted && t?.status === "awaiting_payment"), automatic_retry: false,
    real_money: false, job_enqueued: false, operations_enabled: false};
}
export class CustomerSandboxPixService {
  constructor(private readonly repo: CustomerPixRepository, private readonly provider: Provider) {}
  async read(customerId: string, id: string) {
    const row = await this.repo.read(customerId, id);
    if (!row) throw new CustomerPixError("PIX_NOT_FOUND");
    return pixView(row);
  }
  async create(customerId: string, requestId: string, purchaseId: string) {
    const prior = await this.repo.findRequest(customerId, requestId);
    if (prior) {
      if (prior.purchaseId !== purchaseId) throw new CustomerPixError("PIX_IDEMPOTENCY_CONFLICT");
      // Never POST again, even after timeout, failed save or provider refusal.
      return {data: pixView(prior), replayed: true};
    }
    const context = await this.repo.context(customerId, purchaseId);
    if (!context) throw new CustomerPixError("PIX_PURCHASE_NOT_ELIGIBLE");
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== "test" || !["customers", "liquidity", "custody"].every(v => caps.entitlements.includes(v))
      || !["customers:read", "wallets:read", "transfers:read", "transfers:write"].every(v => caps.scopes.includes(v))) {
      throw new CustomerPixError("PIX_CAPABILITY_REQUIRED");
    }
    const customer = await this.provider.getSandboxCustomerSnapshot(context.providerCustomerId, onboardingExternalRef(customerId));
    if (customer.provider_status !== "approved" || customer.verification_mode !== "full" || customer.requirements_pending !== false) {
      throw new CustomerPixError("PIX_CUSTOMER_NOT_READY");
    }
    const walletId = await this.provider.getCustomerManagedWallet(context.providerCustomerId);
    const row = await this.repo.reserve(customerId, requestId, context, walletId);
    if (!await this.repo.claim(row.id)) {
      const current = await this.repo.read(customerId, row.id);
      if (!current?.attempted) throw new CustomerPixError("PIX_PURCHASE_NOT_ELIGIBLE");
      return {data: pixView(current), replayed: true};
    }
    row.attempted = true;
    const result = await this.provider.createCustomerPixTransfer({customerId: row.providerCustomerId,
      walletId: row.providerWalletId, quoteId: row.providerQuoteId, idempotencyKey: `peragus-pix-${row.id}`,
      metadata: {peragus_pix_id: row.id, peragus_purchase_intent_id: row.purchaseId}});
    // Persist even the reduced HTTP 200 needs_review ID. No instructions are
    // exposed until a complete response is verified against the frozen context.
    await this.repo.bind(row, result.id);
    row.transferId = result.id;
    if (!result.transfer) return {data: pixView(row), replayed: false};
    validatePixTransfer(row, result.transfer);
    return {data: pixView(await this.repo.save(row, result.transfer)), replayed: false};
  }
  async simulatePayment(customerId: string, id: string) {
    let row = await this.repo.read(customerId, id);
    if (!row) throw new CustomerPixError("PIX_NOT_FOUND");
    if (!row.attempted || !row.transferId) throw new CustomerPixError("PIX_SIMULATION_NOT_READY");
    // Refresh and verify the actual bound transfer before making any mutation.
    // A repetition always reads first; it never resets the persisted one-shot claim.
    const current = await this.provider.getTransfer(row.transferId);
    validatePixTransfer(row, current);
    row = await this.repo.save(row, current);
    if (row.simulationAttempted) return {data: pixView(row), replayed: true};
    if (["payment_confirmed", "converting", "payout_initiated", "completed"].includes(current.status)) {
      return {data: pixView(row), replayed: true};
    }
    if (current.status !== "awaiting_payment" || !current.source.paymentInstructions
      || Date.parse(current.source.paymentInstructions.expiresAt) <= Date.now()) {
      throw new CustomerPixError("PIX_SIMULATION_NOT_READY");
    }
    const context = await this.repo.context(customerId, row.purchaseId);
    if (!context || context.providerCustomerId !== row.providerCustomerId || context.providerQuoteId !== row.providerQuoteId
      || context.amountBrl !== row.amountBrl || context.walletAddress !== row.walletAddress) {
      throw new CustomerPixError("PIX_PURCHASE_NOT_ELIGIBLE");
    }
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== "test" || !["customers", "liquidity"].every(v => caps.entitlements.includes(v))
      || !["customers:read", "transfers:read", "transfers:write"].every(v => caps.scopes.includes(v))) {
      throw new CustomerPixError("PIX_CAPABILITY_REQUIRED");
    }
    const customer = await this.provider.getSandboxCustomerSnapshot(row.providerCustomerId, onboardingExternalRef(customerId));
    if (customer.provider_status !== "approved" || customer.verification_mode !== "full" || customer.requirements_pending !== false) {
      throw new CustomerPixError("PIX_CUSTOMER_NOT_READY");
    }
    if (!await this.repo.claimSimulation(row)) {
      const latest = await this.repo.read(customerId, id);
      if (!latest?.simulationAttempted) throw new CustomerPixError("PIX_SIMULATION_NOT_READY");
      return {data: pixView(latest), replayed: true};
    }
    row.simulationAttempted = true;
    await this.provider.simulateCustomerPixPayment(row.transferId!);
    const after = await this.provider.getTransfer(row.transferId!);
    validatePixTransfer(row, after);
    return {data: pixView(await this.repo.save(row, after)), replayed: false};
  }
  async reconcile(customerId: string, id: string) {
    const row = await this.repo.read(customerId, id);
    if (!row) throw new CustomerPixError("PIX_NOT_FOUND");
    if (!row.attempted) return pixView(row);
    const transferId = row.transferId ?? await this.provider.findCustomerPixTransfer(row.providerCustomerId, row.id);
    // An empty listing does not prove that no transfer exists. Never clear claim.
    if (!transferId) return pixView(row);
    const t = await this.provider.getTransfer(transferId);
    validatePixTransfer(row, t);
    await this.repo.bind(row, transferId);
    row.transferId = transferId;
    return pixView(await this.repo.save(row, t));
  }
}
