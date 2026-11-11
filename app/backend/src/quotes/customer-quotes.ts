import type { MoneyMode } from "../config/money-environment.js";
import type {
  OzavClient,
  OzavIndicativeQuote,
} from "../providers/ozav-client.js";
import { OzavClientError } from "../providers/ozav-client.js";
import {
  onboardingExternalRef,
  type SubmissionRepository,
} from "../onboarding/submission-types.js";
import {
  DEFAULT_PURCHASE_LIMITS,
  type PurchaseLimits,
} from "../purchases/operation-status.js";
/**
 * Validates a BRL decimal string and the configured purchase range
 * (PURCHASE_MIN_BRL..PURCHASE_MAX_BRL, in cents). Malformed, nonpositive or
 * above the storage ceiling (10000.00) is QUOTE_AMOUNT_INVALID; outside the
 * configured range is QUOTE_AMOUNT_OUT_OF_RANGE.
 */
export function normalizeQuoteBrl(
  value: string,
  limits: PurchaseLimits,
): string {
  if (!/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value))
    throw new CustomerQuoteError("QUOTE_AMOUNT_INVALID");
  const [whole, fraction = ""] = value.split("."),
    cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > 1000000n)
    throw new CustomerQuoteError("QUOTE_AMOUNT_INVALID");
  if (cents < limits.minCents || cents > limits.maxCents)
    throw new CustomerQuoteError("QUOTE_AMOUNT_OUT_OF_RANGE");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}
/** USDT decimal string (up to 6 places) to integer micro-units; null when not a plain decimal. */
export function usdtMicroUnits(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,20}(\.\d{1,6})?$/.test(value)) return null;
  const [w, f = ""] = value.split(".");
  return BigInt(w!) * 1000000n + BigInt(f.padEnd(6, "0"));
}
export function normalizeQuoteUsdt(value: string): string {
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value))
    throw new CustomerQuoteError("QUOTE_AMOUNT_INVALID");
  const units = usdtMicroUnits(value)!;
  if (units <= 0n) throw new CustomerQuoteError("QUOTE_AMOUNT_INVALID");
  return `${units / 1000000n}.${String(units % 1000000n).padStart(6, "0")}`;
}
export interface CustomerQuoteRecord {
  id: string;
  customerId: string;
  requestId: string;
  providerCustomerId: string;
  amountBrl: string;
  targetAmountUsdt?: string | null;
  attempted: boolean;
  /** OZAV facility terms version; null in test mode (no rate lock there). */
  facilityTermsVersion: string | null;
  /** USDT amount the purchase locks: the quote target; "0.000000" until a quote is saved. */
  lockedUsdtAmount: string;
  quote: OzavIndicativeQuote | null;
  createdAt: string;
}
export interface CustomerQuoteRepository {
  findRequest(
    customerId: string,
    requestId: string,
  ): Promise<CustomerQuoteRecord | null>;
  findOwned(
    customerId: string,
    id: string,
  ): Promise<CustomerQuoteRecord | null>;
  reserve(
    customerId: string,
    requestId: string,
    providerCustomerId: string,
    amountBrl: string,
  ): Promise<CustomerQuoteRecord>;
  reserveTarget?(
    customerId: string,
    requestId: string,
    providerCustomerId: string,
    targetAmount: string,
  ): Promise<CustomerQuoteRecord>;
  claim(id: string): Promise<boolean>;
  save(
    row: CustomerQuoteRecord,
    quote: OzavIndicativeQuote,
  ): Promise<CustomerQuoteRecord>;
}
export class CustomerQuoteError extends Error {
  constructor(
    public readonly code:
      | "QUOTE_AMOUNT_INVALID"
      | "QUOTE_AMOUNT_OUT_OF_RANGE"
      | "QUOTE_CUSTOMER_REQUIRED"
      | "QUOTE_CUSTOMER_NOT_READY"
      | "QUOTE_CAPABILITY_REQUIRED"
      | "QUOTE_IDEMPOTENCY_CONFLICT"
      | "QUOTE_RECOVERY_REQUIRED"
      | "QUOTE_NOT_FOUND"
      | "QUOTE_RATE_LOCK_UNAVAILABLE"
      | "QUOTE_CONFLICT",
    public readonly quoteId?: string,
  ) {
    super(code);
  }
}
export class CustomerQuoteProviderError extends Error {
  constructor(
    public readonly quoteId: string,
    public readonly providerStatus: number | null,
  ) {
    super("QUOTE_PROVIDER_UNAVAILABLE");
  }
}
const renderView = (r: CustomerQuoteRecord, mode: MoneyMode) => ({
  id: r.id,
  request_id: r.requestId,
  state: r.quote ? "quoted" : "uncertain",
  source: {
    currency: "BRL",
    amount: r.amountBrl === "0.00" ? null : r.amountBrl,
  },
  target: r.quote
    ? { currency: "USDT", amount: r.quote.target.amount, chain: "solana" }
    : null,
  rate: r.quote?.rate ?? null,
  rate_type: r.quote?.rateType ?? null,
  exchange_conditions: r.quote
    ? {
        spread_bps: r.quote.spreadBps,
        rate_without_spread: r.quote.rateWithoutSpread,
        amount_deducted: r.quote.amountDeducted,
      }
    : null,
  expires_at: r.quote?.expiresAt ?? null,
  quoted_at: r.quote?.createdAt ?? null,
  recorded_at: r.createdAt,
  environment: mode,
  indicative: true,
  executable: false,
  pricing_scope: "conversion_estimate",
  external_delivery_costs_evaluated: false,
  operations_enabled: false,
});
export class CustomerQuoteService {
  constructor(
    private readonly repository: CustomerQuoteRepository,
    private readonly submissions: SubmissionRepository,
    private readonly provider: Pick<
      OzavClient,
      | "getCustomerCapabilities"
      | "getSandboxCustomerSnapshot"
      | "createCustomerIndicativeQuote"
    >,
    private readonly mode: MoneyMode = "test",
    private readonly limits: PurchaseLimits = DEFAULT_PURCHASE_LIMITS,
  ) {}
  private view(row: CustomerQuoteRecord) {
    return renderView(row, this.mode);
  }
  private check(
    row: CustomerQuoteRecord,
    providerCustomerId: string,
    amountBrl: string,
    targetAmount?: string,
  ) {
    if (
      row.providerCustomerId !== providerCustomerId ||
      (targetAmount
        ? row.targetAmountUsdt !== targetAmount
        : row.targetAmountUsdt != null || row.amountBrl !== amountBrl)
    )
      throw new CustomerQuoteError("QUOTE_IDEMPOTENCY_CONFLICT", row.id);
  }
  async read(customerId: string, id: string) {
    const row = await this.repository.findOwned(customerId, id);
    if (!row) throw new CustomerQuoteError("QUOTE_NOT_FOUND");
    return this.view(row);
  }
  async create(
    customerId: string,
    requestId: string,
    inputAmount: string,
    target = false,
  ) {
    const targetAmount = target ? normalizeQuoteUsdt(inputAmount) : undefined;
    const amountBrl = target
        ? "0.00"
        : normalizeQuoteBrl(inputAmount, this.limits),
      binding = await this.submissions.find(customerId);
    if (!binding || binding.state !== "linked" || !binding.providerId)
      throw new CustomerQuoteError("QUOTE_CUSTOMER_REQUIRED");
    const prior = await this.repository.findRequest(customerId, requestId);
    if (prior) {
      this.check(prior, binding.providerId, amountBrl, targetAmount);
      if (prior.quote) return { data: this.view(prior), replayed: true };
    }
    // Never repeat a quote POST with unknown outcome: this provider operation has
    // no documented idempotency key or quote-list reconciliation endpoint.
    if (prior?.attempted)
      throw new CustomerQuoteError("QUOTE_RECOVERY_REQUIRED", prior.id);
    const caps = await this.provider.getCustomerCapabilities();
    if (
      caps.environment !== this.mode ||
      !["customers", "liquidity"].every((v) => caps.entitlements.includes(v)) ||
      !["customers:read", "quotes:write"].every((v) => caps.scopes.includes(v))
    )
      throw new CustomerQuoteError("QUOTE_CAPABILITY_REQUIRED");
    const customer = await this.provider.getSandboxCustomerSnapshot(
      binding.providerId,
      onboardingExternalRef(customerId),
    );
    if (
      customer.provider_status !== "approved" ||
      customer.verification_mode !== "full" ||
      customer.requirements_pending !== false
    )
      throw new CustomerQuoteError("QUOTE_CUSTOMER_NOT_READY");
    if (targetAmount && !this.repository.reserveTarget)
      throw new CustomerQuoteError("QUOTE_CAPABILITY_REQUIRED");
    const row = targetAmount
      ? await this.repository.reserveTarget!(
          customerId,
          requestId,
          binding.providerId,
          targetAmount,
        )
      : await this.repository.reserve(
          customerId,
          requestId,
          binding.providerId,
          amountBrl,
        );
    this.check(row, binding.providerId, amountBrl, targetAmount);
    if (row.quote) return { data: this.view(row), replayed: true };
    if (!(await this.repository.claim(row.id)))
      throw new CustomerQuoteError("QUOTE_RECOVERY_REQUIRED", row.id);
    let quote: OzavIndicativeQuote;
    try {
      quote = await this.provider.createCustomerIndicativeQuote(
        binding.providerId,
        amountBrl,
        targetAmount,
        // Live quotes ask OZAV for the FX rate lock terms; test keys never do.
        this.mode === "live" ? { facilityPreview: true } : undefined,
      );
    } catch (error) {
      if (error instanceof OzavClientError) {
        if (error.ozavErrorCode === "AMOUNT_BELOW_MINIMUM")
          throw new CustomerQuoteError("QUOTE_AMOUNT_OUT_OF_RANGE", row.id);
        throw new CustomerQuoteProviderError(row.id, error.statusCode ?? null);
      }
      throw error;
    }
    // Without the facility block there is no rate lock to accept: store nothing.
    if (this.mode === "live" && !quote.facility)
      throw new CustomerQuoteError("QUOTE_RATE_LOCK_UNAVAILABLE");
    return {
      data: this.view(await this.repository.save(row, quote)),
      replayed: false,
    };
  }
}
