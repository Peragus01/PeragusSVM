import { OzavClientError } from "../src/providers/ozav-client.js";
import { describe, it, expect } from "vitest";
import {
  assertNotificationEnvironment,
  notificationFailure,
  notificationStep,
  deploymentConfigurationAudit,
  assertDeploymentDatabase,
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

it("validates invitation database isolation independently of financial provider credentials", () => {
  const env = {
    DATABASE_URL: fixture().DATABASE_URL,
    SUPABASE_URL: fixture().SUPABASE_URL,
  };
  expect(
    assertDeploymentDatabase(
      env,
      { RAILWAY_ENVIRONMENT_NAME: "staging" },
      "staging",
    ),
  ).toBe("staging");
  expect(() =>
    assertDeploymentDatabase(
      env,
      { RAILWAY_ENVIRONMENT_NAME: "production" },
      "production",
    ),
  ).toThrow("DATABASE_MISMATCH");
});

it("identifies the failed database comparison without exposing configuration", () => {
  try {
    assertNotificationEnvironment(fixture(), {
      ONBOARDING_EMAIL_DEPLOYMENT_ENV: "production",
    });
  } catch (error) {
    const log = notificationFailure(
      error,
      "configuration",
      "production",
      "synthetic",
    );
    expect(log.fields).toEqual(["DATABASE_USER_PROJECT", "SUPABASE_URL"]);
    expect(JSON.stringify(log)).not.toContain("synthetic@");
    return;
  }
  throw Error("Expected rejection");
});

it("rejects transaction pooling, other databases and URL authority overrides", () => {
  for (const url of [
    fixture().DATABASE_URL.replace(":5432/", ":6543/"),
    fixture().DATABASE_URL.replace("/postgres", "/other"),
    fixture().DATABASE_URL + "?host=other",
  ])
    expect(() =>
      assertNotificationEnvironment(
        { ...fixture(), DATABASE_URL: url },
        { ONBOARDING_EMAIL_DEPLOYMENT_ENV: "staging" },
      ),
    ).toThrow("DATABASE_MISMATCH");
});

it("classifies the session pool limit separately from a generic XX000", () => {
  const error = Object.assign(
    new Error("(EMAXCONNSESSION) private@example.com"),
    { code: "XX000" },
  );
  const log = notificationFailure(error, "cycle", "staging", "synthetic");
  expect(log.database_reason).toBe("EMAXCONNSESSION");
  expect(log.retry).toBe(true);
  expect(JSON.stringify(log)).not.toContain("private@example.com");
});

it("audits only known public identifiers and booleans", () => {
  const result = deploymentConfigurationAudit({
    ...fixture(),
    DATABASE_SSL: "true",
    RAILWAY_ENVIRONMENT_NAME: "production",
  });
  expect(result.database_project).toBe("lybdkqkbwlfwvmmvstzi");
  expect(result.auth_project).toBe("lybdkqkbwlfwvmmvstzi");
  expect(JSON.stringify(result)).not.toContain("synthetic");
  expect(
    JSON.stringify(
      deploymentConfigurationAudit({
        DATABASE_URL: "postgres://private:secret@private.example/secret",
      }),
    ),
  ).not.toContain("secret");
});
describe("notification deployment isolation", () => {
  it("pins staging and production independently", () => {
    expect(
      assertNotificationEnvironment(fixture(), {
        ONBOARDING_EMAIL_DEPLOYMENT_ENV: "staging",
      }),
    ).toBe("staging");
    expect(
      assertNotificationEnvironment(
        { ...fixture("athwkklyvnaetotmancy"), OZAV_API_KEY: "ozav_sk_live_synthetic" },
        { ONBOARDING_EMAIL_DEPLOYMENT_ENV: "production" },
      ),
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

it("reports configuration field names without rejected values", () => {
  const error = Object.assign(new Error("ENVIRONMENT_CONFIGURATION_INVALID"), {
    fields: ["OZAV_API_KEY", "private@example.com", "DATABASE_URL"],
  });
  const log = notificationFailure(error, "bootstrap", "staging", "synthetic");
  expect(log.category).toBe("configuration");
  expect(log.retry).toBe(false);
  expect(log.fields).toEqual(["OZAV_API_KEY", "DATABASE_URL"]);
});

it("records the failing provider stage and HTTP category without its body", async () => {
  try {
    await notificationStep("provider_registration", async () => {
      throw new OzavClientError("private@example.com token=secret", false, 401);
    });
  } catch (error) {
    const log = notificationFailure(
      error,
      "customer_cycle",
      "staging",
      "synthetic",
    );
    expect(log.stage).toBe("provider_registration");
    expect(log.category).toBe("provider");
    expect(log.code).toBe("OZAV_HTTP_401");
    expect(log.retry).toBe(false);
    expect(JSON.stringify(log)).not.toContain("secret");
    return;
  }
  throw Error("Expected provider error");
});

describe("provider key follows the money mode", () => {
  const production = { ...fixture("athwkklyvnaetotmancy"), OZAV_API_KEY: "ozav_sk_live_synthetic" };
  it("accepts a live key in production and refuses a test key there", () => {
    expect(
      assertNotificationEnvironment(production, { ONBOARDING_EMAIL_DEPLOYMENT_ENV: "production" }),
    ).toBe("production");
    expect(() =>
      assertNotificationEnvironment(
        { ...production, OZAV_API_KEY: "ozav_sk_test_synthetic" },
        { ONBOARDING_EMAIL_DEPLOYMENT_ENV: "production" },
      ),
    ).toThrow("ONBOARDING_LIVE_PROVIDER_REQUIRED");
  });
  it("audits whether the provider key matches the money mode without printing it", () => {
    const live = deploymentConfigurationAudit({ PERAGUS_DEPLOYMENT_ENV: "production", OZAV_API_KEY: "ozav_sk_live_synthetic" });
    expect(live).toMatchObject({ provider_key_mode: "live", provider_matches_money_mode: true });
    expect(
      deploymentConfigurationAudit({ PERAGUS_DEPLOYMENT_ENV: "production", OZAV_API_KEY: "ozav_sk_test_synthetic" }),
    ).toMatchObject({ provider_key_mode: "test", provider_matches_money_mode: false });
    expect(deploymentConfigurationAudit({ OZAV_API_KEY: "ozav_sk_test_synthetic" })).toMatchObject({
      provider_key_mode: "test",
      provider_matches_money_mode: true,
    });
    expect(JSON.stringify(live)).not.toContain("ozav_sk_live_synthetic");
  });
});
