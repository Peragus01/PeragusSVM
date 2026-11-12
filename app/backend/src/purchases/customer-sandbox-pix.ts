import { moneyNetworkFor, type MoneyMode } from "../config/money-environment.js";
import {OzavFacilityLockRefusedError, type OzavClient, type OzavFacilityOutcome, type OzavTransfer} from "../providers/ozav-client.js";
import {onboardingExternalRef} from "../onboarding/submission-types.js";
import type {OperationStatus} from "./operation-status.js";
import type {PurchaseIntentRepository} from "./customer-purchase-intents.js";
import {usdtMicroUnits} from "../quotes/customer-quotes.js";

export class CustomerPixError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export interface PixContext {
  purchaseId: string; providerCustomerId: string; providerQuoteId: string;
  amountBrl: string; walletAddress: string;
  /** From the accepted (immutable) purchase: the FX lock terms accepted with the quote (live) and the locked USDT. */
  facilityTermsVersion?: string | null; lockedUsdtAmount?: string;
}
export interface CustomerPixRecord extends PixContext {
  id: string; customerId: string; requestId: string; providerWalletId: string;
  attempted: boolean; simulationAttempted: boolean; transferId: string | null; observation: OzavTransfer | null;
  /** Status of the purchase operation this charge funds. */
  operationStatus?: OperationStatus;
  /** Live: FX rate lock deadline (facility.deadline_at), ISO; instructions are not payable after it. */
  lockDeadlineAt?: string | null;
  /** Customer cancel request (policy 7.1): instructions are never shown afterwards. */
  cancelRequestedAt?: string | null;
}
/** Moves the purchase operation; validated again by the database. */
export type PixOperations = Pick<PurchaseIntentRepository, "transitionOperation">;
export interface CustomerPixRepository {
  /** "create": the operation must still be accepted; otherwise accepted or awaiting_pix. */
  context(customerId: string, purchaseId: string, stage?: "create"): Promise<PixContext | null>;
  findRequest(customerId: string, requestId: string): Promise<CustomerPixRecord | null>;
  read(customerId: string, id: string): Promise<CustomerPixRecord | null>;
  reserve(customerId: string, requestId: string, context: PixContext, walletId: string): Promise<CustomerPixRecord>;
  claim(id: string): Promise<boolean>;
  claimSimulation(row: CustomerPixRecord): Promise<boolean>;
  bind(row: CustomerPixRecord, transferId: string): Promise<void>;
  save(row: CustomerPixRecord, transfer: OzavTransfer): Promise<CustomerPixRecord>;
  /** Stores the lock deadline once (never changed afterwards). */
  recordLockDeadline(row: CustomerPixRecord, deadlineAt: string): Promise<void>;
}
type Provider = Pick<OzavClient, "getCustomerCapabilities" | "getSandboxCustomerSnapshot" | "getCustomerManagedWallet" |
  "createCustomerPixTransfer" | "findCustomerPixTransfer" | "getTransfer" | "simulateCustomerPixPayment">;
const PIX_ACTOR = "system:pix";
/** Strict RFC 3339 instant with an explicit offset; null when missing or malformed. */
const instant = (value: string | null | undefined) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
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
export function pixView(row: CustomerPixRecord, mode: MoneyMode = "test") {
  const t = row.observation, instructions = t?.source.paymentInstructions;
  const status = row.operationStatus ?? null, closed = status === "failed" || status === "expired";
  // Live instructions only after the FX lock was accepted and verified (operation awaiting_pix),
  // and only until the earlier of the Pix expiry and the lock deadline.
  const deadline = row.lockDeadlineAt ? Date.parse(row.lockDeadlineAt) : null;
  const locked = mode === "test" || (status === "awaiting_pix" && deadline !== null && !Number.isNaN(deadline));
  const until = instructions ? Math.min(Date.parse(instructions.expiresAt), deadline ?? Infinity) : NaN;
  const cancelRequestedAt = row.cancelRequestedAt ?? null;
  const payable = !closed && locked && !cancelRequestedAt && !row.simulationAttempted && t?.status === "awaiting_payment" && instructions && until > Date.now();
  return {id: row.id, purchase_intent_id: row.purchaseId, request_id: row.requestId,
    state: t?.status ?? (closed ? status : row.attempted ? "uncertain" : "reserved"), status, environment: mode,
    source: {currency: "BRL", amount: row.amountBrl},
    funding_destination: {type: "provider_managed_wallet"},
    subsequent_delivery: {wallet_address: row.walletAddress, proof_network: moneyNetworkFor(mode), started: false},
    payment_instructions: payable ? {br_code: instructions.brCode, qr_code_image: instructions.qrCodeImage, expires_at: new Date(until).toISOString()} : null,
    simulation_attempted: row.simulationAttempted, cancel_requested_at: cancelRequestedAt,
    source_leg_status: t?.sourceLegStatus ?? null, destination_leg_status: t?.destinationLegStatus ?? null,
    payment_confirmed: t?.sourceLegStatus === "completed" && ["payment_confirmed", "converting", "payout_initiated", "completed"].includes(t.status),
    custody_conversion_completed: t?.status === "completed" && t.sourceLegStatus === "completed" && t.destinationLegStatus === "completed",
    recovery_required: !closed && ((row.attempted && !t) || (row.simulationAttempted && t?.status === "awaiting_payment")), automatic_retry: false,
    real_money: mode === "live", job_enqueued: false, operations_enabled: false};
}
/**
 * Creates the OZAV transfer fiat_payment -> customer's managed wallet for an accepted
 * purchase and exposes its Pix instructions. In live the transfer carries the FX rate
 * lock acceptance; instructions are shown only when OZAV locked the rate at the
 * purchase's locked USDT amount. A refused or unverifiable lock fails the operation.
 */
export class CustomerPixService {
  constructor(private readonly repo: CustomerPixRepository, private readonly provider: Provider,
    private readonly mode: MoneyMode = "test", private readonly operations?: PixOperations) {}
  private async fail(row: CustomerPixRecord, reason: string, code: string): Promise<never> {
    await this.operations!.transitionOperation(row.purchaseId, "failed", PIX_ACTOR, reason);
    throw new CustomerPixError(code);
  }
  /**
   * Live: the rate must be locked for at least the purchase's locked_usdt_amount
   * (facility.amount >= locked, in micro-units; Ruling 18) with a valid future deadline.
   */
  private async checkLock(row: CustomerPixRecord, context: PixContext, facility: OzavFacilityOutcome | null) {
    if (!facility?.locked) {
      return this.fail(row, `RATE_LOCK_NOT_APPLIED: state=${facility?.state ?? "missing"}${facility?.reason ? ` reason=${facility.reason}` : ""}`,
        "PIX_RATE_LOCK_UNAVAILABLE");
    }
    const expected = usdtMicroUnits(context.lockedUsdtAmount), actual = usdtMicroUnits(facility.amount);
    if (facility.currency !== "USDT" || expected === null || actual === null || actual < expected) {
      return this.fail(row, `LOCKED_AMOUNT_MISMATCH: facility.amount=${facility.amount} ${facility.currency} locked_usdt_amount=${context.lockedUsdtAmount}`,
        "PIX_LOCKED_AMOUNT_MISMATCH");
    }
    const deadlineAt = instant(facility.deadlineAt);
    if (!deadlineAt || Date.parse(deadlineAt) <= Date.now()) {
      return this.fail(row, `LOCK_DEADLINE_INVALID: deadline_at=${facility.deadlineAt === null ? "missing" : JSON.stringify(facility.deadlineAt.slice(0, 64))}`,
        "PIX_RATE_LOCK_UNAVAILABLE");
    }
    return {deadlineAt, reason: `rate_locked: facility.amount=${facility.amount} ${facility.currency} deadline_at=${deadlineAt}`};
  }
  async read(customerId: string, id: string) {
    const row = await this.repo.read(customerId, id);
    if (!row) throw new CustomerPixError("PIX_NOT_FOUND");
    return pixView(row, this.mode);
  }
  async create(customerId: string, requestId: string, purchaseId: string) {
    const prior = await this.repo.findRequest(customerId, requestId);
    if (prior) {
      if (prior.purchaseId !== purchaseId) throw new CustomerPixError("PIX_IDEMPOTENCY_CONFLICT");
      // Never POST again, even after timeout, failed save or provider refusal.
      return {data: pixView(prior, this.mode), replayed: true};
    }
    // Only an accepted operation can fund a new Pix: refuse before any provider call.
    const context = await this.repo.context(customerId, purchaseId, "create");
    if (!context) throw new CustomerPixError("PIX_PURCHASE_NOT_ELIGIBLE");
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== this.mode || !["customers", "liquidity", "custody"].every(v => caps.entitlements.includes(v))
      || !["customers:read", "wallets:read", "transfers:read", "transfers:write"].every(v => caps.scopes.includes(v))) {
      throw new CustomerPixError("PIX_CAPABILITY_REQUIRED");
    }
    const customer = await this.provider.getSandboxCustomerSnapshot(context.providerCustomerId, onboardingExternalRef(customerId));
    if (customer.provider_status !== "approved" || customer.verification_mode !== "full" || customer.requirements_pending !== false) {
      throw new CustomerPixError("PIX_CUSTOMER_NOT_READY");
    }
    const live = this.mode === "live";
    // Live: no FX lock to accept, or nothing to record its outcome with, means no Pix at all.
    if (live && (!context.facilityTermsVersion || !this.operations)) throw new CustomerPixError("PIX_RATE_LOCK_REQUIRED");
    const walletId = await this.provider.getCustomerManagedWallet(context.providerCustomerId);
    const row = await this.repo.reserve(customerId, requestId, context, walletId);
    if (!await this.repo.claim(row.id)) {
      const current = await this.repo.read(customerId, row.id);
      if (!current?.attempted) throw new CustomerPixError("PIX_PURCHASE_NOT_ELIGIBLE");
      return {data: pixView(current, this.mode), replayed: true};
    }
    row.attempted = true;
    let result: Awaited<ReturnType<Provider["createCustomerPixTransfer"]>>;
    try {
      result = await this.provider.createCustomerPixTransfer({customerId: row.providerCustomerId,
        walletId: row.providerWalletId, quoteId: row.providerQuoteId, idempotencyKey: `peragus-pix-${row.id}`,
        metadata: {peragus_pix_id: row.id, peragus_purchase_intent_id: row.purchaseId},
        ...(live ? {facilityTermsVersion: context.facilityTermsVersion!} : {})});
    } catch (error) {
      // OZAV documents that nothing was created: the operation fails, the claim stays.
      if (live && error instanceof OzavFacilityLockRefusedError) {
        return this.fail(row, `RATE_LOCK_REFUSED: ${error.ozavErrorCode}${error.reason ? ` reason=${error.reason}` : ""}`,
          "PIX_RATE_LOCK_UNAVAILABLE");
      }
      throw error;
    }
    // Persist even the reduced HTTP 200 needs_review ID. No instructions are
    // exposed until a complete response is verified against the frozen context.
    await this.repo.bind(row, result.id);
    row.transferId = result.id;
    if (!result.transfer) return {data: pixView(row, this.mode), replayed: false};
    validatePixTransfer(row, result.transfer);
    const saved = await this.repo.save(row, result.transfer);
    // The lock outcome exists only on this response (GET never returns it).
    const lock = live ? await this.checkLock(saved, context, result.facility) : null;
    if (lock) await this.repo.recordLockDeadline(saved, lock.deadlineAt);
    const reason = lock?.reason ?? "pix_instructions_issued";
    if (this.operations && saved.observation?.status === "awaiting_payment" && saved.observation.source.paymentInstructions) {
      await this.operations.transitionOperation(row.purchaseId, "awaiting_pix", PIX_ACTOR, reason);
      return {data: pixView((await this.repo.read(customerId, row.id)) ?? saved, this.mode), replayed: false};
    }
    return {data: pixView(saved, this.mode), replayed: false};
  }
  async simulatePayment(customerId: string, id: string) {
    // Sandbox only: live payments are real Pix transfers made by the customer.
    if (this.mode !== "test") throw new CustomerPixError("PIX_SIMULATION_NOT_AVAILABLE");
    let row = await this.repo.read(customerId, id);
    if (!row) throw new CustomerPixError("PIX_NOT_FOUND");
    if (!row.attempted || !row.transferId) throw new CustomerPixError("PIX_SIMULATION_NOT_READY");
    // A cancelled order hides its instructions: there is nothing to pay in the sandbox either.
    if (row.cancelRequestedAt) throw new CustomerPixError("PIX_SIMULATION_NOT_READY");
    // Refresh and verify the actual bound transfer before making any mutation.
    // A repetition always reads first; it never resets the persisted one-shot claim.
    const current = await this.provider.getTransfer(row.transferId);
    validatePixTransfer(row, current);
    row = await this.repo.save(row, current);
    if (row.simulationAttempted) return {data: pixView(row, this.mode), replayed: true};
    if (["payment_confirmed", "converting", "payout_initiated", "completed"].includes(current.status)) {
      return {data: pixView(row, this.mode), replayed: true};
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
    if (caps.environment !== this.mode || !["customers", "liquidity"].every(v => caps.entitlements.includes(v))
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
      return {data: pixView(latest, this.mode), replayed: true};
    }
    row.simulationAttempted = true;
    await this.provider.simulateCustomerPixPayment(row.transferId!);
    const after = await this.provider.getTransfer(row.transferId!);
    validatePixTransfer(row, after);
    return {data: pixView(await this.repo.save(row, after), this.mode), replayed: false};
  }
  async reconcile(customerId: string, id: string) {
    return reconcileCustomerPix(this.repo,this.provider,customerId,id,this.mode);
  }
}

/** Former name, kept so existing callers keep compiling. */
export const CustomerSandboxPixService = CustomerPixService;
export type CustomerSandboxPixService = CustomerPixService;

/**
 * GET-only recovery; cannot reserve, claim, create or simulate a Pix. It never moves
 * the operation: in live the lock outcome is not recoverable by GET, so a recovered
 * charge whose operation is not awaiting_pix never exposes instructions.
 */
export async function reconcileCustomerPix(
  repo: Pick<CustomerPixRepository,"read"|"bind"|"save">,
  provider: Pick<Provider,"findCustomerPixTransfer"|"getTransfer">,
  customerId: string, id: string, mode: MoneyMode = "test",
) {
  const row = await repo.read(customerId, id);
  if (!row) throw new CustomerPixError("PIX_NOT_FOUND");
  if (!row.attempted) return pixView(row, mode);
  const transferId = row.transferId ?? await provider.findCustomerPixTransfer(row.providerCustomerId, row.id);
  // An empty listing does not prove that no transfer exists. Never clear claim.
  if (!transferId) return pixView(row, mode);
  const t = await provider.getTransfer(transferId);
  validatePixTransfer(row, t);
  await repo.bind(row, transferId);
  row.transferId = transferId;
  return pixView(await repo.save(row, t), mode);
}
