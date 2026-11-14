import { describe, expect, it, vi } from "vitest";
import { runWithSwitches, withDeadline } from "../scripts/lib/staging-smoke-switches.mjs";

const KEYS = ["onboarding", "new_operations", "usdt_sends"];

// Fake operator API: a map of switch states mutated by setSwitch, with a call log.
function fakeApi(initial: Record<string, boolean>) {
  const state = { ...initial };
  const calls: string[] = [];
  return {
    state,
    calls,
    getStates: async () => ({ ...state }),
    setSwitch: vi.fn(async (key: string, enabled: boolean) => {
      calls.push(`${key}=${enabled}`);
      state[key] = enabled;
    }),
  };
}

describe("runWithSwitches", () => {
  it("turns ON only switches that were OFF and turns them OFF after success", async () => {
    const api = fakeApi({ onboarding: false, new_operations: false, usdt_sends: false });
    const result = await runWithSwitches({ keys: KEYS, ...api, journey: async () => {} });
    expect(result).toEqual({ failure: null, restoreFailures: [] });
    expect(api.state).toEqual({ onboarding: false, new_operations: false, usdt_sends: false });
  });

  it("restores after a journey failure and reports it", async () => {
    const api = fakeApi({ onboarding: false, new_operations: false, usdt_sends: false });
    const boom = new Error("step failed");
    const result = await runWithSwitches({
      keys: KEYS,
      ...api,
      journey: async () => {
        expect(Object.values(api.state)).toEqual([true, true, true]);
        throw boom;
      },
    });
    expect(result.failure).toBe(boom);
    expect(Object.values(api.state)).toEqual([false, false, false]);
  });

  it("restores after a step timeout (deadline aborts the shared flag)", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ onboarding: false, new_operations: false, usdt_sends: false });
      const abort = new AbortController();
      const run = runWithSwitches({
        keys: KEYS,
        ...api,
        journey: () =>
          withDeadline(
            () => new Promise(() => {}),
            1000,
            () => new Error("timeout"),
            () => abort.abort(),
          ),
      });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await run;
      expect((result.failure as Error).message).toBe("timeout");
      expect(abort.signal.aborted).toBe(true);
      expect(Object.values(api.state)).toEqual([false, false, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores after an abort signal (SIGINT path)", async () => {
    const api = fakeApi({ onboarding: false, new_operations: false, usdt_sends: false });
    const abort = new AbortController();
    const run = runWithSwitches({
      keys: KEYS,
      ...api,
      journey: () =>
        new Promise((_, reject) => {
          abort.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          setTimeout(() => abort.abort(), 5);
        }),
    });
    const result = await run;
    expect((result.failure as Error).message).toBe("aborted");
    expect(Object.values(api.state)).toEqual([false, false, false]);
  });

  it("leaves switches that were already ON alone", async () => {
    const api = fakeApi({ onboarding: true, new_operations: false, usdt_sends: false });
    await runWithSwitches({
      keys: KEYS,
      ...api,
      journey: async () => {
        throw new Error("fail");
      },
    });
    expect(api.calls).not.toContain("onboarding=true");
    expect(api.calls).not.toContain("onboarding=false");
    expect(api.state.onboarding).toBe(true);
    expect(api.state.new_operations).toBe(false);
    expect(api.state.usdt_sends).toBe(false);
  });

  it("restores a switch whose ON call failed halfway, and reports restore failures", async () => {
    const api = fakeApi({ onboarding: false, new_operations: false, usdt_sends: false });
    api.setSwitch.mockImplementation(async (key: string, enabled: boolean) => {
      api.calls.push(`${key}=${enabled}`);
      if (key === "new_operations" && enabled) throw new Error("ON failed");
      if (key === "onboarding" && !enabled) throw new Error("OFF failed");
      api.state[key] = enabled;
    });
    const result = await runWithSwitches({ keys: KEYS, ...api, journey: async () => {} });
    expect((result.failure as Error).message).toBe("ON failed");
    expect(api.calls).toContain("new_operations=false");
    expect(result.restoreFailures).toEqual(["onboarding"]);
    expect(api.calls).not.toContain("usdt_sends=true");
  });
});
