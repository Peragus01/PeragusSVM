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

export type MoneyNetwork = MoneyEnvironment["network"];

/** Solana network bound to a money mode; the database enforces the same pairing. */
export const moneyNetworkFor = (mode: MoneyMode): MoneyNetwork =>
  mode === "live" ? "solana:mainnet" : "solana:devnet";

/** True when the OZAV secret key belongs to the given money mode (ozav_sk_<mode>_...). */
export function providerKeyMatchesMode(
  key: string | undefined | null,
  mode: MoneyMode,
): boolean {
  if (mode !== "test" && mode !== "live") return false;
  return new RegExp(`^ozav_sk_${mode}_[A-Za-z0-9_-]+$`).test(key ?? "");
}

/**
 * Sandbox money executors that must stay off while the money mode is live.
 * CUSTOMER_SANDBOX_PIX_ENABLED is absent: the customer Pix path is live-safe (the
 * transfer carries the accepted FX rate lock and instructions are shown only for a
 * verified lock); its simulation stays refused. SANDBOX_WITHDRAWAL_EXECUTION_ENABLED
 * is absent since Task 10: the execution path sends live USDT (locked amount, destination
 * identification, token-account check, one claim per operation). Closure stays refused.
 * SANDBOX_WITHDRAWAL_RECOVERY_ENABLED is deliberately absent: its provider reader
 * exposes GET operations only and cannot reserve, claim or send.
 */
export const SANDBOX_MONEY_PATH_FLAGS = [
  "CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED",
  "CUSTOMER_VERIFICATION_SIMULATION_ENABLED",
  "SANDBOX_WITHDRAWAL_CLOSURE_ENABLED",
] as const;
export type SandboxMoneyPathFlag = (typeof SANDBOX_MONEY_PATH_FLAGS)[number];

/** Flags that are enabled but not allowed in this mode (always empty in test). */
export function moneyPathsNotLiveReady(
  mode: MoneyMode,
  flags: Partial<Record<SandboxMoneyPathFlag, boolean>>,
): SandboxMoneyPathFlag[] {
  return mode === "live" ? SANDBOX_MONEY_PATH_FLAGS.filter((flag) => flags[flag] === true) : [];
}
