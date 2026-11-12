// Purchase operation lifecycle. Mirrored in SQL by
// peragus_operation_can_transition() (migrations 045, 048); a test compares both.
export type OperationStatus =
  | "quoted"
  | "accepted"
  | "awaiting_pix"
  | "pix_confirmed"
  | "converted"
  | "awaiting_approval"
  | "approved"
  | "sending"
  | "sent"
  | "delivered_verified"
  | "expired"
  | "failed"
  | "needs_review"
  | "refund_pending"
  | "refunded";

export const OPERATION_STATUSES: readonly OperationStatus[] = [
  "quoted",
  "accepted",
  "awaiting_pix",
  "pix_confirmed",
  "converted",
  "awaiting_approval",
  "approved",
  "sending",
  "sent",
  "delivered_verified",
  "expired",
  "failed",
  "needs_review",
  "refund_pending",
  "refunded",
];

export const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set([
  "delivered_verified",
  "expired",
  "failed",
  "refunded",
]);

export const OPEN_STATUSES: ReadonlySet<OperationStatus> = new Set(
  OPERATION_STATUSES.filter((s) => !TERMINAL_STATUSES.has(s)),
);

// Purchase intents are created at `accepted`; nothing transitions into `quoted`.
// After money may have moved (pix_confirmed onwards) failures go to
// needs_review/refund_pending, never straight to failed/expired.
const TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  quoted: ["accepted", "expired"],
  // needs_review: an ambiguous live Pix create whose FX lock outcome is unknown (048).
  accepted: ["awaiting_pix", "expired", "failed", "needs_review"],
  awaiting_pix: ["pix_confirmed", "converted", "expired", "failed", "needs_review", "refund_pending"],
  pix_confirmed: ["converted", "needs_review", "refund_pending"],
  converted: ["awaiting_approval", "needs_review", "refund_pending"],
  awaiting_approval: ["approved", "needs_review", "refund_pending"],
  approved: ["sending", "needs_review"],
  sending: ["sent", "needs_review"],
  sent: ["delivered_verified", "needs_review"],
  needs_review: ["awaiting_approval", "refund_pending", "failed"],
  refund_pending: ["refunded", "needs_review"],
  delivered_verified: [],
  expired: [],
  failed: [],
  refunded: [],
};

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isOperationStatus(value: unknown): value is OperationStatus {
  return typeof value === "string" && (OPERATION_STATUSES as readonly string[]).includes(value);
}

export interface PurchaseLimits {
  minCents: bigint;
  maxCents: bigint;
}

export const DEFAULT_PURCHASE_LIMITS: PurchaseLimits = { minCents: 100000n, maxCents: 100000n };

/** Parses a BRL decimal string ("1000", "1000.5", "1000.00") into cents. */
export function brlToCents(value: string): bigint {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) throw new Error("BRL_AMOUNT_INVALID");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function centsToBrl(cents: bigint): string {
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${cents / 100n}.${fraction}`;
}

export function purchaseLimits(env: { PURCHASE_MIN_BRL: string; PURCHASE_MAX_BRL: string }): PurchaseLimits {
  return { minCents: brlToCents(env.PURCHASE_MIN_BRL), maxCents: brlToCents(env.PURCHASE_MAX_BRL) };
}
