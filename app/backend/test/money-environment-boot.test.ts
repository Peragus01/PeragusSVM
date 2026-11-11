import { describe, expect, it } from "vitest";
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  resolveMoneyEnvironment,
} from "../src/config/money-environment.js";
import { assertMoneyEnvironmentAtBoot, runMoneyEnvironmentBootChecks } from "../src/config/money-environment-boot.js";

const live = resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "production" });
const test = resolveMoneyEnvironment({
  PERAGUS_DEPLOYMENT_ENV: "staging",
  SOLANA_USDT_MINT: "So11111111111111111111111111111111111111112",
});
const probes = (ozav: string, genesis: string) => ({
  ozavEnvironment: async () => ozav,
  solanaGenesisHash: async () => genesis,
});

describe("runMoneyEnvironmentBootChecks", () => {
  const mk = (ozav = "live", genesis: string = MAINNET_GENESIS_HASH) => {
    const calls = { ozav: 0, solana: 0 };
    return {
      calls,
      deps: {
        ozavClient: () => ({ getCapabilities: async () => { calls.ozav++; return { environment: ozav }; } }),
        solanaConnection: () => ({ getGenesisHash: async () => { calls.solana++; return genesis; } }),
      },
    };
  };
  const prod = { PERAGUS_DEPLOYMENT_ENV: "production" as const, SOLANA_RPC_URL: "https://rpc.example", OZAV_API_KEY: "ozav_sk_live_x" };
  const staging = { PERAGUS_DEPLOYMENT_ENV: "staging" as const, SOLANA_USDT_MINT: "m".repeat(40) };
  const log = () => {};

  it("skips only when not deployed", async () => {
    const { deps, calls } = mk();
    await runMoneyEnvironmentBootChecks(staging, deps, log, {});
    expect(calls).toEqual({ ozav: 0, solana: 0 });
  });
  it("runs both probes when deployed with a key", async () => {
    const { deps, calls } = mk();
    await runMoneyEnvironmentBootChecks(prod, deps, log, { RAILWAY_ENVIRONMENT_NAME: "production" });
    expect(calls).toEqual({ ozav: 1, solana: 1 });
  });
  it("runs the Solana probe without an OZAV key and rejects a devnet RPC", async () => {
    const { deps, calls } = mk("live", DEVNET_GENESIS_HASH);
    await expect(
      runMoneyEnvironmentBootChecks({ ...prod, OZAV_API_KEY: undefined }, deps, log, { RAILWAY_ENVIRONMENT_NAME: "production" }),
    ).rejects.toMatchObject({ code: "MONEY_ENVIRONMENT_MISMATCH", field: "solana_rpc" });
    expect(calls.ozav).toBe(0);
    expect(calls.solana).toBe(1);
  });
  it("refuses Railway production with a non-production deployment env", async () => {
    const { deps } = mk("test", DEVNET_GENESIS_HASH);
    await expect(
      runMoneyEnvironmentBootChecks(staging, deps, log, { RAILWAY_ENVIRONMENT_NAME: "production" }),
    ).rejects.toMatchObject({ code: "MONEY_ENVIRONMENT_MISMATCH", field: "deployment" });
  });
  it("refuses production deployment env on a non-production Railway environment", async () => {
    const { deps } = mk();
    await expect(
      runMoneyEnvironmentBootChecks(prod, deps, log, { RAILWAY_ENVIRONMENT_NAME: "staging" }),
    ).rejects.toMatchObject({ code: "MONEY_ENVIRONMENT_MISMATCH", field: "deployment" });
  });
  it("rejects when OZAV reports the wrong environment", async () => {
    const { deps } = mk("test");
    await expect(
      runMoneyEnvironmentBootChecks(prod, deps, log, { RAILWAY_ENVIRONMENT_NAME: "production" }),
    ).rejects.toMatchObject({ field: "ozav" });
  });
});

describe("deployment_configuration_audit money fields", () => {
  it("reports money_mode and network without secrets", async () => {
    const { deploymentConfigurationAudit } = await import("../src/notifications/runtime-safety.js");
    const prod = deploymentConfigurationAudit({ PERAGUS_DEPLOYMENT_ENV: "production", OZAV_API_KEY: "ozav_sk_live_x" });
    expect(prod).toMatchObject({ money_mode: "live", network: "solana:mainnet" });
    expect(deploymentConfigurationAudit({})).toMatchObject({ money_mode: "test", network: "solana:devnet" });
    expect(JSON.stringify(prod)).not.toContain("ozav_sk_live_x");
  });
});

describe("assertMoneyEnvironmentAtBoot", () => {
  it("accepts live with live capabilities and mainnet genesis", async () => {
    await expect(
      assertMoneyEnvironmentAtBoot(live, probes("live", MAINNET_GENESIS_HASH)),
    ).resolves.toBeUndefined();
  });
  it("accepts test with test capabilities and devnet genesis", async () => {
    await expect(
      assertMoneyEnvironmentAtBoot(test, probes("test", DEVNET_GENESIS_HASH)),
    ).resolves.toBeUndefined();
  });
  it("rejects live when OZAV reports test", async () => {
    await expect(
      assertMoneyEnvironmentAtBoot(live, probes("test", MAINNET_GENESIS_HASH)),
    ).rejects.toMatchObject({ code: "MONEY_ENVIRONMENT_MISMATCH", field: "ozav" });
  });
  it("rejects live when RPC is devnet", async () => {
    await expect(
      assertMoneyEnvironmentAtBoot(live, probes("live", DEVNET_GENESIS_HASH)),
    ).rejects.toMatchObject({ code: "MONEY_ENVIRONMENT_MISMATCH", field: "solana_rpc" });
  });
  it("rejects test when RPC is mainnet", async () => {
    await expect(
      assertMoneyEnvironmentAtBoot(test, probes("test", MAINNET_GENESIS_HASH)),
    ).rejects.toMatchObject({ code: "MONEY_ENVIRONMENT_MISMATCH", field: "solana_rpc" });
  });
  it("fails closed when a probe throws", async () => {
    await expect(
      assertMoneyEnvironmentAtBoot(live, {
        ozavEnvironment: async () => { throw new Error("boom"); },
        solanaGenesisHash: async () => MAINNET_GENESIS_HASH,
      }),
    ).rejects.toMatchObject({ code: "MONEY_ENVIRONMENT_MISMATCH", field: "ozav" });
    await expect(
      assertMoneyEnvironmentAtBoot(live, {
        ozavEnvironment: async () => "live",
        solanaGenesisHash: async () => { throw new Error("boom"); },
      }),
    ).rejects.toMatchObject({ code: "MONEY_ENVIRONMENT_MISMATCH", field: "solana_rpc" });
  });
});
