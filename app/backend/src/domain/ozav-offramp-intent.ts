export const ozavTransferStatuses = [
  "awaiting_payment",
  "payment_confirmed",
  "converting",
  "payout_initiated",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "needs_review",
  "awaiting_approval",
] as const;

export type OzavTransferStatus =
  (typeof ozavTransferStatuses)[number];

export interface OzavOfframpIntentRequest {
  settlementId: string;
  customerId: string;
  walletId: string;
  payoutDestinationId: string;
  sourceAmountUsdt: string;
  spreadBps: number;
  idempotencyKey: string;
}

export interface OzavOfframpIntent
  extends OzavOfframpIntentRequest {
  quoteId: string | null;
  quoteTargetAmountBrl: string | null;
  transferId: string | null;
  providerStatus: OzavTransferStatus | null;
  transferSourceAmountUsdt: string | null;
  transferTargetAmountBrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class OzavOfframpInitiationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OzavOfframpInitiationError";
  }
}

export class OzavOfframpSettlementNotFoundError
  extends OzavOfframpInitiationError
{
  constructor(public readonly settlementId: string) {
    super(`Settlement not found: ${settlementId}`);
    this.name = "OzavOfframpSettlementNotFoundError";
  }
}

function validId(value: string, prefix: string): boolean {
  return typeof value === "string"
    && value.length <= 128
    && value.startsWith(prefix)
    && value.length > prefix.length
    && /^[A-Za-z0-9_]+$/.test(value);
}

function canonicalDecimal(
  value: string,
  maximumFractionDigits: number,
): string {
  if (
    typeof value !== "string"
    || !/^\d+(?:\.\d+)?$/.test(value)
  ) {
    throw new OzavOfframpInitiationError(
      "Invalid OZAV off-ramp amount",
    );
  }

  const [rawWhole = "", rawFraction = ""] =
    value.split(".");
  const fraction = rawFraction.replace(/0+$/, "");

  if (fraction.length > maximumFractionDigits) {
    throw new OzavOfframpInitiationError(
      "OZAV off-ramp amount exceeds supported precision",
    );
  }

  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const normalized = fraction
    ? `${whole}.${fraction}`
    : whole;

  if (BigInt(whole) === 0n && !/[1-9]/.test(fraction)) {
    throw new OzavOfframpInitiationError(
      "OZAV off-ramp amount must be positive",
    );
  }

  return normalized;
}

export function normalizeOzavUsdtAmount(
  value: string,
): string {
  return canonicalDecimal(value, 6);
}

export function normalizeOzavOfframpBrlAmount(
  value: string,
): string {
  return canonicalDecimal(value, 6);
}

export function normalizeOzavTransferStatus(
  value: string,
): OzavTransferStatus {
  if (
    !ozavTransferStatuses.includes(
      value as OzavTransferStatus,
    )
  ) {
    throw new OzavOfframpInitiationError(
      "Invalid OZAV transfer status",
    );
  }

  return value as OzavTransferStatus;
}

export function normalizeOzavOfframpIntentRequest(
  input: OzavOfframpIntentRequest,
): OzavOfframpIntentRequest {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(input.settlementId)
    || !validId(input.customerId, "ozav_cus_")
    || !validId(input.walletId, "ozav_wal_")
    || !validId(
      input.payoutDestinationId,
      "ozav_pd_",
    )
    || !Number.isInteger(input.spreadBps)
    || input.spreadBps < 0
    || input.spreadBps > 10_000
    || !/^[A-Za-z0-9_-]{16,256}$/.test(
      input.idempotencyKey,
    )
  ) {
    throw new OzavOfframpInitiationError(
      "Invalid OZAV off-ramp intent",
    );
  }

  return {
    settlementId: input.settlementId.toLowerCase(),
    customerId: input.customerId,
    walletId: input.walletId,
    payoutDestinationId: input.payoutDestinationId,
    sourceAmountUsdt: normalizeOzavUsdtAmount(
      input.sourceAmountUsdt,
    ),
    spreadBps: input.spreadBps,
    idempotencyKey: input.idempotencyKey,
  };
}

export function sameOzavOfframpIntentRequest(
  left: OzavOfframpIntentRequest,
  right: OzavOfframpIntentRequest,
): boolean {
  return left.settlementId === right.settlementId
    && left.customerId === right.customerId
    && left.walletId === right.walletId
    && left.payoutDestinationId
      === right.payoutDestinationId
    && left.sourceAmountUsdt === right.sourceAmountUsdt
    && left.spreadBps === right.spreadBps
    && left.idempotencyKey === right.idempotencyKey;
}

export function ozavOfframpIdempotencyKey(
  settlementId: string,
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(settlementId)
  ) {
    throw new OzavOfframpInitiationError(
      "Invalid settlement ID for OZAV off-ramp idempotency",
    );
  }

  return `peragus_offramp_${settlementId
    .toLowerCase()
    .replaceAll("-", "")}`;
}
