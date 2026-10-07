export interface OzavOnrampIntentRequest {
  settlementId: string;
  customerId: string;
  walletId: string;
  sourceAmountBrl: string;
  spreadBps: number;
  idempotencyKey: string;
}

export interface OzavPixPaymentInstructions {
  transferId: string;
  intentId: string;
  brCode: string;
  qrCodeImage: string | null;
  expiresAt: Date;
}

export interface OzavOnrampIntent
  extends OzavOnrampIntentRequest {
  quoteId: string | null;
  quoteTargetAmountUsdt: string | null;
  paymentInstructions: OzavPixPaymentInstructions | null;
  createdAt: Date;
  updatedAt: Date;
}

export class OzavOnrampInitiationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OzavOnrampInitiationError";
  }
}

function validId(value: string, prefix: string): boolean {
  return typeof value === "string"
    && value.length <= 128
    && value.startsWith(prefix)
    && value.length > prefix.length
    && /^[A-Za-z0-9_]+$/.test(value);
}

export function normalizeOzavPixPaymentInstructions(
  input: OzavPixPaymentInstructions,
): OzavPixPaymentInstructions {
  if (
    !validId(input.transferId, "ozav_tr_")
    || typeof input.intentId !== "string"
    || input.intentId.length < 1
    || input.intentId.length > 128
    || typeof input.brCode !== "string"
    || input.brCode.length < 1
    || input.brCode.length > 4_096
    || (
      input.qrCodeImage !== null
      && (
        typeof input.qrCodeImage !== "string"
        || input.qrCodeImage.length < 1
        || input.qrCodeImage.length > 1_048_576
      )
    )
    || !(input.expiresAt instanceof Date)
    || Number.isNaN(input.expiresAt.getTime())
  ) {
    throw new OzavOnrampInitiationError(
      "Invalid OZAV Pix payment instructions",
    );
  }
  return {
    transferId: input.transferId,
    intentId: input.intentId,
    brCode: input.brCode,
    qrCodeImage: input.qrCodeImage,
    expiresAt: new Date(input.expiresAt),
  };
}

function canonicalDecimal(
  value: string,
  maximumFractionDigits: number,
): string {
  if (
    typeof value !== "string"
    || !/^\d+(?:\.\d+)?$/.test(value)
  ) {
    throw new OzavOnrampInitiationError(
      "Invalid OZAV on-ramp amount",
    );
  }
  const [rawWhole = "", rawFraction = ""] = value.split(".");
  const fraction = rawFraction.replace(/0+$/, "");
  if (fraction.length > maximumFractionDigits) {
    throw new OzavOnrampInitiationError(
      "OZAV on-ramp amount exceeds supported precision",
    );
  }
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function normalizeOzavBrlAmount(
  value: string,
): string {
  return canonicalDecimal(value, 2);
}

export function normalizeOzavOnrampIntentRequest(
  input: OzavOnrampIntentRequest,
): OzavOnrampIntentRequest {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(input.settlementId)
    || !validId(input.customerId, "ozav_cus_")
    || !validId(input.walletId, "ozav_wal_")
    || !Number.isInteger(input.spreadBps)
    || input.spreadBps < 0
    || input.spreadBps > 10_000
    || !/^[A-Za-z0-9_-]{16,256}$/.test(input.idempotencyKey)
  ) {
    throw new OzavOnrampInitiationError(
      "Invalid OZAV on-ramp intent",
    );
  }
  return {
    settlementId: input.settlementId.toLowerCase(),
    customerId: input.customerId,
    walletId: input.walletId,
    sourceAmountBrl: normalizeOzavBrlAmount(
      input.sourceAmountBrl,
    ),
    spreadBps: input.spreadBps,
    idempotencyKey: input.idempotencyKey,
  };
}

export function normalizeOzavQuoteTargetAmount(
  value: string,
): string {
  return canonicalDecimal(value, 6);
}

export function sameOzavOnrampIntentRequest(
  left: OzavOnrampIntentRequest,
  right: OzavOnrampIntentRequest,
): boolean {
  return left.settlementId === right.settlementId
    && left.customerId === right.customerId
    && left.walletId === right.walletId
    && left.sourceAmountBrl === right.sourceAmountBrl
    && left.spreadBps === right.spreadBps
    && left.idempotencyKey === right.idempotencyKey;
}

export function settlementAmountToBrl(
  amount: string,
  decimals: number,
): string {
  if (
    !/^[1-9]\d*$/.test(amount)
    || !Number.isInteger(decimals)
    || decimals < 0
    || decimals > 9
  ) {
    throw new OzavOnrampInitiationError(
      "Invalid settlement source amount",
    );
  }
  const value = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  if (fraction.length > 2) {
    throw new OzavOnrampInitiationError(
      "Settlement source amount is below BRL cent precision",
    );
  }
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function ozavIdempotencyKey(
  settlementId: string,
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(settlementId)
  ) {
    throw new OzavOnrampInitiationError(
      "Invalid settlement ID for OZAV idempotency",
    );
  }
  return `peragus_settlement_${settlementId
    .toLowerCase()
    .replaceAll("-", "")}`;
}
