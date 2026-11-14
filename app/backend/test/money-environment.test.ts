import { describe, expect, it } from "vitest";
import { resolveMoneyEnvironment, TEST_MODE_USDT_MINT_PLACEHOLDER } from "../src/config/money-environment.js";
import { OzavClient } from "../src/providers/ozav-client.js";
import { OzavSandboxWithdrawalProvider } from "../src/providers/ozav-sandbox-withdrawal.js";

const CANONICAL = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("resolveMoneyEnvironment", () => {
  it("resolves production to live mainnet", () => {
    const env = resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "production", SOLANA_USDT_MINT: undefined });
    expect(env).toMatchObject({
      mode: "live",
      network: "solana:mainnet",
      ozavKeyPrefix: "ozav_sk_live_",
      usdtMint: CANONICAL,
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      walletProofDomain: "www.peragus.com.br",
      appOrigin: "https://www.peragus.com.br",
      explorerCluster: "mainnet-beta",
    });
  });

  it("resolves staging to test devnet", () => {
    const env = resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "staging", SOLANA_USDT_MINT: DEVNET_MINT });
    expect(env).toMatchObject({
      mode: "test",
      network: "solana:devnet",
      ozavKeyPrefix: "ozav_sk_test_",
      usdtMint: DEVNET_MINT,
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      walletProofDomain: "peragussvm-staging.up.railway.app",
      explorerCluster: "devnet",
    });
  });

  it("rejects a production mint other than canonical", () => {
    expect(() => resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "production", SOLANA_USDT_MINT: DEVNET_MINT }))
      .toThrowError(expect.objectContaining({ code: "MONEY_ENVIRONMENT_INVALID" }));
  });

  it("staging without a mint resolves to the placeholder (the OZAV sandbox delivers nothing on Solana)", () => {
    expect(TEST_MODE_USDT_MINT_PLACEHOLDER).toBe("11111111111111111111111111111111");
    for (const SOLANA_USDT_MINT of [undefined, ""]) {
      const env = resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "staging", SOLANA_USDT_MINT });
      expect(env).toMatchObject({ mode: "test", network: "solana:devnet", usdtMint: TEST_MODE_USDT_MINT_PLACEHOLDER });
    }
  });

  it("staging with a mint keeps using it", () => {
    expect(resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "staging", SOLANA_USDT_MINT: DEVNET_MINT }).usdtMint).toBe(DEVNET_MINT);
  });

  it("production never uses the placeholder: canonical when missing, boot refused for another mint", () => {
    expect(resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "production", SOLANA_USDT_MINT: undefined }).usdtMint).toBe(CANONICAL);
    expect(resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "production", SOLANA_USDT_MINT: CANONICAL }).usdtMint).toBe(CANONICAL);
    expect(() => resolveMoneyEnvironment({ PERAGUS_DEPLOYMENT_ENV: "production", SOLANA_USDT_MINT: TEST_MODE_USDT_MINT_PLACEHOLDER }))
      .toThrowError(expect.objectContaining({ code: "MONEY_ENVIRONMENT_INVALID" }));
  });
});

describe("OZAV key by mode", () => {
  it("OzavClient rejects key of the other mode", () => {
    expect(() => new OzavClient({ apiKey: "ozav_sk_test_x", mode: "live" })).toThrow();
    expect(() => new OzavClient({ apiKey: "ozav_sk_live_x", mode: "test" })).toThrow();
    expect(() => new OzavClient({ apiKey: "ozav_sk_live_x", mode: "live" })).not.toThrow();
    expect(() => new OzavClient({ apiKey: "ozav_sk_test_x", mode: "test" })).not.toThrow();
  });

  it("OzavSandboxWithdrawalProvider rejects key of the other mode", () => {
    expect(() => new OzavSandboxWithdrawalProvider("ozav_sk_live_x", { mode: "test" })).toThrow();
    expect(() => new OzavSandboxWithdrawalProvider("ozav_sk_test_x", { mode: "live" })).toThrow();
    expect(() => new OzavSandboxWithdrawalProvider("ozav_sk_test_x", { mode: "test" })).not.toThrow();
  });
});
