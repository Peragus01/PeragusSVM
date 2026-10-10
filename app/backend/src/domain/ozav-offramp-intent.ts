import { createHash } from "node:crypto";

import type {
  OzavEvent,
  OzavTransfer,
} from "../providers/ozav-client.js";

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

export interface OzavOfframpStoredEvent {
  eventId: string;
  settlementId: string;
  transferId: string;
  eventType: string;
  occurredAt: string;
  contentHash: string;
  snapshot: {
    status: OzavTransferStatus;
    sourceLegStatus: string | null;
    destinationLegStatus: string | null;
    sourceAmountUsdt: string;
    targetAmountBrl: string;
  };
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

function normalizeLegStatus(
  value: string | null,
): string | null {
  if (
    value !== null
    && (
      typeof value !== "string"
      || value.length < 1
      || value.length > 64
    )
  ) {
    throw new OzavOfframpInitiationError(
      "Invalid OZAV off-ramp leg status",
    );
  }

  return value;
}

export function assertOzavOfframpTransferMatches(
  intent: OzavOfframpIntent,
  transfer: OzavTransfer,
): void {
  if (
    (intent.transferId !== null
      && transfer.id !== intent.transferId)
    || transfer.customerId !== intent.customerId
    || transfer.quoteId !== intent.quoteId
    || transfer.source.type !== "wallet"
    || transfer.source.walletId !== intent.walletId
    || transfer.source.currency !== "USDT"
    || transfer.destination.type
      !== "payout_destination"
    || transfer.destination.payoutDestinationId
      !== intent.payoutDestinationId
    || transfer.amounts.source.currency !== "USDT"
    || normalizeOzavUsdtAmount(
      transfer.amounts.source.amount,
    ) !== intent.sourceAmountUsdt
    || transfer.amounts.target.currency !== "BRL"
  ) {
    throw new OzavOfframpInitiationError(
      "OZAV transfer does not match the off-ramp intent",
    );
  }

  normalizeOzavOfframpBrlAmount(
    transfer.amounts.target.amount,
  );
  normalizeOzavTransferStatus(transfer.status);
  normalizeLegStatus(transfer.sourceLegStatus);
  normalizeLegStatus(transfer.destinationLegStatus);
}

/** Stores financial settlement facts only; no payout destination details. */
export function normalizeOzavOfframpEvent(
  intent: OzavOfframpIntent,
  event: OzavEvent,
): OzavOfframpStoredEvent {
  if (
    !intent.transferId
    || !validId(event.id, "ozav_evt_")
    || !event.type.startsWith("transfer.")
    || event.type.length > 128
    || !event.transfer
    || Number.isNaN(Date.parse(event.createdAt))
  ) {
    throw new OzavOfframpInitiationError(
      "Invalid OZAV off-ramp transfer event",
    );
  }

  assertOzavOfframpTransferMatches(intent, event.transfer);

  const snapshot = {
    status: normalizeOzavTransferStatus(
      event.transfer.status,
    ),
    sourceLegStatus: normalizeLegStatus(
      event.transfer.sourceLegStatus,
    ),
    destinationLegStatus: normalizeLegStatus(
      event.transfer.destinationLegStatus,
    ),
    sourceAmountUsdt: normalizeOzavUsdtAmount(
      event.transfer.amounts.source.amount,
    ),
    targetAmountBrl: normalizeOzavOfframpBrlAmount(
      event.transfer.amounts.target.amount,
    ),
  };
  const content = {
    eventId: event.id,
    settlementId: intent.settlementId,
    transferId: intent.transferId,
    eventType: event.type,
    occurredAt: new Date(event.createdAt).toISOString(),
    snapshot,
  };

  return {
    ...content,
    contentHash: createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex"),
  };
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
