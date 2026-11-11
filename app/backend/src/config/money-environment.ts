import { INVITE_STAGING_ORIGIN } from "../invites/invite-email-template.js";
import type { Env } from "./env.js";

export type MoneyMode = "test" | "live";

export interface MoneyEnvironment {
  mode: MoneyMode;
  network: "solana:devnet" | "solana:mainnet";
  ozavKeyPrefix: "ozav_sk_test_" | "ozav_sk_live_";
  usdtMint: string;
  genesisHash: string;
  walletProofDomain: string;
  appOrigin: string;
  explorerCluster: "devnet" | "mainnet-beta";
}

export const MAINNET_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const invalid = (): Error =>
  Object.assign(new Error("MONEY_ENVIRONMENT_INVALID"), {
    code: "MONEY_ENVIRONMENT_INVALID",
  });

/** Derives the only valid money environment for a deployment. */
export function resolveMoneyEnvironment(
  env: Pick<Env, "PERAGUS_DEPLOYMENT_ENV" | "SOLANA_USDT_MINT">,
): MoneyEnvironment {
  if (env.PERAGUS_DEPLOYMENT_ENV === "production") {
    if (env.SOLANA_USDT_MINT && env.SOLANA_USDT_MINT !== MAINNET_USDT_MINT) {
      throw invalid();
    }
    return {
      mode: "live",
      network: "solana:mainnet",
      ozavKeyPrefix: "ozav_sk_live_",
      usdtMint: MAINNET_USDT_MINT,
      genesisHash: MAINNET_GENESIS_HASH,
      walletProofDomain: "www.peragus.com.br",
      appOrigin: "https://www.peragus.com.br",
      explorerCluster: "mainnet-beta",
    };
  }
  if (!env.SOLANA_USDT_MINT) throw invalid();
  return {
    mode: "test",
    network: "solana:devnet",
    ozavKeyPrefix: "ozav_sk_test_",
    usdtMint: env.SOLANA_USDT_MINT,
    genesisHash: DEVNET_GENESIS_HASH,
    walletProofDomain: "peragussvm-staging.up.railway.app",
    appOrigin: INVITE_STAGING_ORIGIN,
    explorerCluster: "devnet",
  };
}

/** Mode only, without requiring the USDT mint; safe for processes that do not touch purchase flows. */
export const moneyModeFor = (
  env: Pick<Env, "PERAGUS_DEPLOYMENT_ENV">,
): MoneyMode => (env.PERAGUS_DEPLOYMENT_ENV === "production" ? "live" : "test");
