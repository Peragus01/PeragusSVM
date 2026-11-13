import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const issues = async () => {
  const { envSchema } = await import("../src/config/env.js");
  const result = envSchema.safeParse(process.env);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("final review I12: live money paths need their safeguards", () => {
  const live = () => {
    vi.stubEnv("PERAGUS_DEPLOYMENT_ENV", "production");
    vi.stubEnv("OZAV_API_KEY", "ozav_sk_live_synthetic");
    vi.stubEnv("CUSTOMER_SANDBOX_PIX_ENABLED", "true");
  };
  it("refuses live Pix with refunds/webhooks off or TRUST_PROXY_HOPS=0", async () => {
    live();
    vi.stubEnv("MANUAL_REFUNDS_ENABLED", "false");
    vi.stubEnv("CUSTOMER_WEBHOOKS_ENABLED", "false");
    vi.stubEnv("TRUST_PROXY_HOPS", "0");
    const messages = await issues();
    for (const field of ["MANUAL_REFUNDS_ENABLED", "CUSTOMER_WEBHOOKS_ENABLED", "TRUST_PROXY_HOPS"])
      expect(messages).toContain(`LIVE_MONEY_PATH_REQUIRES_SAFEGUARD: ${field}`);
  });
  it("no safeguard issue once all three are set, nor in test mode", async () => {
    live();
    vi.stubEnv("MANUAL_REFUNDS_ENABLED", "true");
    vi.stubEnv("CUSTOMER_WEBHOOKS_ENABLED", "true");
    vi.stubEnv("TRUST_PROXY_HOPS", "1");
    expect((await issues()).filter((m) => m.startsWith("LIVE_MONEY_PATH_REQUIRES_SAFEGUARD"))).toEqual([]);
    vi.stubEnv("PERAGUS_DEPLOYMENT_ENV", "staging");
    vi.stubEnv("OZAV_API_KEY", "ozav_sk_test_synthetic");
    vi.stubEnv("TRUST_PROXY_HOPS", "0");
    vi.stubEnv("MANUAL_REFUNDS_ENABLED", "false");
    vi.resetModules();
    expect((await issues()).filter((m) => m.startsWith("LIVE_MONEY_PATH_REQUIRES_SAFEGUARD"))).toEqual([]);
  });
  it("new env vars default to the documented values", async () => {
    vi.stubEnv("PERAGUS_DEPLOYMENT_ENV", "staging");
    const { envSchema } = await import("../src/config/env.js");
    const env = envSchema.parse({ PERAGUS_DEPLOYMENT_ENV: "staging" });
    expect([env.ACCEPTED_OPERATION_TTL_MINUTES, env.PIX_CREATE_NOT_FOUND_GRACE_MINUTES, env.PIX_INSTRUCTIONS_HIDE_MARGIN_MINUTES,
      env.PIX_EXPIRY_GRACE_MINUTES, env.DAILY_REVIEW_FLOOR_DATE]).toEqual([30, 30, 5, 10, "2026-11-01"]);
    expect(envSchema.safeParse({ PERAGUS_DEPLOYMENT_ENV: "staging", DAILY_REVIEW_FLOOR_DATE: "2026-13-40" }).success).toBe(false);
  });
});
