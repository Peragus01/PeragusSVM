import { createHash } from "node:crypto";
import type { OzavEvent, OzavTransfer } from "../providers/ozav-client.js";

export interface OzavOnrampBinding {
  settlementId: string;
  transferId: string;
  customerId: string;
  walletId: string;
  quoteId: string;
}

export class OzavPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OzavPersistenceError";
  }
}

export interface OzavStoredEvent {
  eventId: string;
  settlementId: string;
  transferId: string;
  eventType: string;
  occurredAt: string;
  contentHash: string;
  snapshot: {
    status: string;
    sourceLegStatus: string | null;
    destinationLegStatus: string | null;
    sourceAmountBrl: string;
    targetAmountUsdt: string;
  };
}

function validId(value: string, prefix: string): boolean {
  return typeof value === "string" && value.length <= 128
    && value.startsWith(prefix) && value.length > prefix.length
    && /^[A-Za-z0-9_]+$/.test(value);
}

export function normalizeOzavBinding(input: OzavOnrampBinding): OzavOnrampBinding {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.settlementId)
    || !validId(input.transferId, "ozav_tr_")
    || !validId(input.customerId, "ozav_cus_")
    || !validId(input.walletId, "ozav_wal_")
    || !validId(input.quoteId, "ozav_q_")) {
    throw new OzavPersistenceError("Invalid OZAV binding identifiers");
  }
  return { ...input, settlementId: input.settlementId.toLowerCase() };
}

export function sameOzavBinding(a: OzavOnrampBinding, b: OzavOnrampBinding): boolean {
  return a.settlementId === b.settlementId && a.transferId === b.transferId
    && a.customerId === b.customerId && a.walletId === b.walletId
    && a.quoteId === b.quoteId;
}

export function assertOzavOnrampMatches(binding: OzavOnrampBinding, transfer: OzavTransfer): void {
  if (transfer.id !== binding.transferId || transfer.customerId !== binding.customerId
    || transfer.quoteId !== binding.quoteId || transfer.destination.walletId !== binding.walletId
    || transfer.source.type !== "fiat_payment" || transfer.source.rail !== "pix"
    || transfer.source.currency !== "BRL" || transfer.destination.type !== "wallet"
    || transfer.amounts.source.currency !== "BRL" || transfer.amounts.target.currency !== "USDT") {
    throw new OzavPersistenceError("OZAV transfer does not match the settlement on-ramp binding");
  }
}

function decimal(value: string): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new OzavPersistenceError("Invalid OZAV event amount");
  }
  const [whole = "", fraction = ""] = value.split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
}

function status(value: string | null): string | null {
  if (value !== null && (typeof value !== "string" || !value.length || value.length > 64)) {
    throw new OzavPersistenceError("Invalid OZAV event status");
  }
  return value;
}

/** Only normalized financial fields are stored; no customer PII or PIX QR body. */
export function normalizeOzavEvent(input: OzavOnrampBinding, event: OzavEvent): OzavStoredEvent {
  const binding = normalizeOzavBinding(input);
  if (!validId(event.id, "ozav_evt_") || !event.type.startsWith("transfer.")
    || event.type.length > 128 || !event.transfer || Number.isNaN(Date.parse(event.createdAt))) {
    throw new OzavPersistenceError("Invalid OZAV transfer event");
  }
  assertOzavOnrampMatches(binding, event.transfer);
  const snapshot = {
    status: status(event.transfer.status)!,
    sourceLegStatus: status(event.transfer.sourceLegStatus),
    destinationLegStatus: status(event.transfer.destinationLegStatus),
    sourceAmountBrl: decimal(event.transfer.amounts.source.amount),
    targetAmountUsdt: decimal(event.transfer.amounts.target.amount),
  };
  const content = {
    eventId: event.id,
    settlementId: binding.settlementId,
    transferId: binding.transferId,
    eventType: event.type,
    occurredAt: new Date(event.createdAt).toISOString(),
    snapshot,
  };
  return {
    ...content,
    contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}
