import type { SettlementStatus } from "./settlement.js";

export const settlementTransitions = {
  created: ["awaiting_pix", "failed", "revoked"],
  awaiting_pix: ["pix_confirmed", "failed", "revoked"],
  pix_confirmed: ["tokenized", "failed", "revoked"],
  tokenized: ["settling", "failed"],
  settling: ["settled", "failed"],
  settled: ["offramping", "failed"],
  offramping: ["paid_out", "failed"],
  paid_out: [],
  failed: [],
  revoked: [],
} as const satisfies Record<
  SettlementStatus,
  readonly SettlementStatus[]
>;

export class InvalidSettlementTransitionError extends Error {
  constructor(
    public readonly currentStatus: SettlementStatus,
    public readonly nextStatus: SettlementStatus,
  ) {
    super(
      `Invalid settlement transition: ${currentStatus} -> ${nextStatus}`,
    );
    this.name = "InvalidSettlementTransitionError";
  }
}

export function canTransitionSettlement(
  currentStatus: SettlementStatus,
  nextStatus: SettlementStatus,
): boolean {
  return settlementTransitions[currentStatus].some(
    (candidate: SettlementStatus) => candidate === nextStatus,
  );
}

export function assertSettlementTransition(
  currentStatus: SettlementStatus,
  nextStatus: SettlementStatus,
): void {
  if (!canTransitionSettlement(currentStatus, nextStatus)) {
    throw new InvalidSettlementTransitionError(
      currentStatus,
      nextStatus,
    );
  }
}
