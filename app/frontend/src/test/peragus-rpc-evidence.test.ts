import { describe, expect, it } from "vitest";
import { initialRpcEvidence, observeRpc } from "@/lib/peragus/rpc-evidence";

describe("RPC confirmation evidence", () => {
  it("raises RPC_INTEGRITY_ALERT for a later lower-slot failure without changing frozen latency", () => {
    const success = observeRpc(initialRpcEvidence(), {
      status: "confirmed",
      slot: 420,
      elapsedMs: 125,
    });
    expect(success.frozenLatencyMs).toBe(125);
    expect(success.alert).toBeNull();
    const lateFailure = observeRpc(success, {
      status: "failed",
      slot: 419,
      elapsedMs: 980,
    });
    expect(lateFailure.alert).toBe("RPC_INTEGRITY_ALERT");
    expect(lateFailure.frozenLatencyMs).toBe(125);
    expect(lateFailure.status).toBe("confirmed");
    expect(lateFailure.slot).toBe(420);
    expect(success.alert).toBeNull();
  });
});
