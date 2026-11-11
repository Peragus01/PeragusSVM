import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SANDBOX_MONEY_PATH_FLAGS,
  moneyPathsNotLiveReady,
  providerKeyMatchesMode,
} from "../src/config/money-environment.js";
import { MAINNET_USDT_MINT } from "../src/config/money-environment.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const freshGetEnv = async () => (await import("../src/config/env.js")).getEnv;

describe("sandbox money paths are refused in live", () => {
  for (const flag of SANDBOX_MONEY_PATH_FLAGS) {
    it(`refuses ${flag} when the money mode is live`, async () => {
      vi.stubEnv("PERAGUS_DEPLOYMENT_ENV", "production");
      vi.stubEnv("OZAV_API_KEY", "ozav_sk_live_synthetic");
      vi.stubEnv(flag, "true");
      const getEnv = await freshGetEnv();
      expect(() => getEnv()).toThrow(
        expect.objectContaining({ code: "MONEY_PATH_NOT_LIVE_READY", fields: [flag] }),
      );
      expect(() => getEnv()).toThrow(`MONEY_PATH_NOT_LIVE_READY: ${flag}`);
    });
    it(`allows ${flag} when the money mode is test`, async () => {
      vi.stubEnv("PERAGUS_DEPLOYMENT_ENV", "staging");
      vi.stubEnv("OZAV_API_KEY", "ozav_sk_test_synthetic");
      vi.stubEnv("SOLANA_USDT_MINT", MAINNET_USDT_MINT);
      vi.stubEnv(flag, "true");
      const getEnv = await freshGetEnv();
      let error: unknown;
      try {
        getEnv();
      } catch (e) {
        error = e;
      }
      expect((error as { code?: string } | undefined)?.code).not.toBe("MONEY_PATH_NOT_LIVE_READY");
      expect(moneyPathsNotLiveReady("test", { [flag]: true })).toEqual([]);
    });
  }
  it("keeps the GET-only withdrawal recovery reader allowed in live", () => {
    expect(SANDBOX_MONEY_PATH_FLAGS).not.toContain("SANDBOX_WITHDRAWAL_RECOVERY_ENABLED");
    expect(
      moneyPathsNotLiveReady("live", {
        CUSTOMER_SANDBOX_PIX_ENABLED: true,
        SANDBOX_WITHDRAWAL_EXECUTION_ENABLED: true,
      }),
    ).toEqual(["CUSTOMER_SANDBOX_PIX_ENABLED", "SANDBOX_WITHDRAWAL_EXECUTION_ENABLED"]);
  });
});

describe("providerKeyMatchesMode", () => {
  it("matches only the key prefix of the given mode", () => {
    expect(providerKeyMatchesMode("ozav_sk_live_abc", "live")).toBe(true);
    expect(providerKeyMatchesMode("ozav_sk_test_abc", "test")).toBe(true);
    expect(providerKeyMatchesMode("ozav_sk_test_abc", "live")).toBe(false);
    expect(providerKeyMatchesMode("ozav_sk_live_abc", "test")).toBe(false);
    expect(providerKeyMatchesMode(undefined, "test")).toBe(false);
    expect(providerKeyMatchesMode("ozav_sk_live_", "live")).toBe(false);
    expect(providerKeyMatchesMode("ozav_sk_live_a b", "live")).toBe(false);
  });
});
