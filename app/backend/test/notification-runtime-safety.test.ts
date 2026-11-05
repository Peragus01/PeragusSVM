import { describe, it, expect } from "vitest";
import {
  assertNotificationEnvironment,
  notificationFailure,
} from "../src/notifications/runtime-safety.js";
const fixture = (project = "lybdkqkbwlfwvmmvstzi") => ({
  DATABASE_URL: `postgresql://postgres.${project}:synthetic@aws-1-sa-east-1.pooler.supabase.com:5432/postgres`,
  SUPABASE_URL: `https://${project}.supabase.co`,
  OZAV_API_KEY: "ozav_sk_test_synthetic",
  OZAV_ONRAMP_WRITES_ENABLED: false,
  OZAV_OFFRAMP_WRITES_ENABLED: false,
  SOLANA_COSIGNING_ENABLED: false,
  SOLANA_CONTINGENCY_RESERVE_ENABLED: false,
  PERAGUS_SANDBOX_DEMO_ENABLED: false,
  CUSTOMER_VERIFICATION_SIMULATION_ENABLED: false,
  CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED: false,
});
describe("notification deployment isolation", () => {
  it("pins staging and production independently", () => {
    expect(
      assertNotificationEnvironment(fixture(), {
        ONBOARDING_EMAIL_DEPLOYMENT_ENV: "staging",
      }),
    ).toBe("staging");
    expect(
      assertNotificationEnvironment(fixture("athwkklyvnaetotmancy"), {
        ONBOARDING_EMAIL_DEPLOYMENT_ENV: "production",
      }),
    ).toBe("production");
    expect(() =>
      assertNotificationEnvironment(fixture(), {
        ONBOARDING_EMAIL_DEPLOYMENT_ENV: "production",
      }),
    ).toThrow("DATABASE_MISMATCH");
  });
  it("rejects missing mode, financial flags, live keys and Railway mismatches", () => {
    expect(() => assertNotificationEnvironment(fixture(), {})).toThrow(
      "ENV_REQUIRED",
    );
    for (const flag of [
      "OZAV_ONRAMP_WRITES_ENABLED",
      "OZAV_OFFRAMP_WRITES_ENABLED",
      "SOLANA_COSIGNING_ENABLED",
      "SOLANA_CONTINGENCY_RESERVE_ENABLED",
      "PERAGUS_SANDBOX_DEMO_ENABLED",
      "CUSTOMER_VERIFICATION_SIMULATION_ENABLED",
      "CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED",
    ])
      expect(() =>
        assertNotificationEnvironment(
          { ...fixture(), [flag]: true },
          { ONBOARDING_EMAIL_DEPLOYMENT_ENV: "staging" },
        ),
      ).toThrow("UNSAFE_FLAGS");
    expect(() =>
      assertNotificationEnvironment(
        { ...fixture(), OZAV_API_KEY: "ozav_sk_live_synthetic" },
        { ONBOARDING_EMAIL_DEPLOYMENT_ENV: "staging" },
      ),
    ).toThrow("TEST_PROVIDER_REQUIRED");
    expect(() =>
      assertNotificationEnvironment(fixture(), {
        ONBOARDING_EMAIL_DEPLOYMENT_ENV: "staging",
        RAILWAY_ENVIRONMENT_NAME: "production",
      }),
    ).toThrow("ENV_MISMATCH");
  });
  it("does not serialize arbitrary exception messages or details", () => {
    const secret = "private@example.com password=secret";
    const log = notificationFailure(
      Object.assign(new Error(secret), { code: "42P01", detail: secret }),
      "worker",
      "production",
      "synthetic",
    );
    expect(log.code).toBe("42P01");
    expect(log.retry).toBe(false);
    expect(JSON.stringify(log)).not.toContain(secret);
  });
});
