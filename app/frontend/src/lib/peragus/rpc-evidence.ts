export type RpcEvidence = {
  status: "pending" | "confirmed" | "failed";
  slot: number | null;
  frozenLatencyMs: number | null;
  alert: "RPC_INTEGRITY_ALERT" | null;
};
export type RpcObservation = {
  slot: number;
  status: "pending" | "confirmed" | "failed";
  elapsedMs: number;
};
export const initialRpcEvidence = (): RpcEvidence => ({
  status: "pending",
  slot: null,
  frozenLatencyMs: null,
  alert: null,
});

/** Contradictions must be checked before discarding stale slots. */
export function observeRpc(state: RpcEvidence, observation: RpcObservation): RpcEvidence {
  if (state.status === "confirmed") {
    return observation.status === "failed" ? { ...state, alert: "RPC_INTEGRITY_ALERT" } : state;
  }
  if (state.slot !== null && observation.slot < state.slot) return state;
  return {
    ...state,
    status: observation.status,
    slot: observation.slot,
    frozenLatencyMs:
      observation.status === "confirmed" ? observation.elapsedMs : state.frozenLatencyMs,
  };
}
