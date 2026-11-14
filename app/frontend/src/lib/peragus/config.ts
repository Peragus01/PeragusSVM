/** Public, non-secret runtime configuration. Vite variables are bundled into the browser. */
const env = import.meta.env as Record<string, string | undefined>;

export const config = {
  apiBaseUrl: (env["VITE_API_BASE_URL"] || "/api").replace(/\/$/, ""),
  solanaRpcUrl: env["VITE_SOLANA_RPC_URL"] || defaultSolanaRpcUrl(moneyMode()),
  demoCorridorId: env["VITE_DEMO_CORRIDOR_ID"] || "",
  demoRecipientWallet: env["VITE_DEMO_RECIPIENT_WALLET"] || "",
  demoPayoutDestinationId: env["VITE_DEMO_PAYOUT_DESTINATION_ID"] || "",
};

export type MoneyMode = "test" | "live";
export type MoneyNetwork = "solana:devnet" | "solana:mainnet";

/**
 * Money mode of this deployment, from the public build variable VITE_PERAGUS_MONEY_MODE.
 * Only the exact value "live" selects live; anything else stays in test mode, which keeps
 * the test notices visible and refuses live backend responses (fail closed).
 */
export function moneyMode(): MoneyMode {
  return (import.meta.env as Record<string, string | undefined>)["VITE_PERAGUS_MONEY_MODE"] ===
    "live"
    ? "live"
    : "test";
}
/** React-facing accessor for the configured money mode. */
export function useMoneyMode(): MoneyMode {
  return moneyMode();
}
/** Public RPC used when VITE_SOLANA_RPC_URL is not set: never devnet in live. */
export function defaultSolanaRpcUrl(mode: MoneyMode) {
  return mode === "live" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
}
export const moneyNetwork = (mode: MoneyMode): MoneyNetwork =>
  mode === "live" ? "solana:mainnet" : "solana:devnet";
/** Domain the backend binds into the wallet ownership proof for this mode. */
export const walletProofDomain = (mode: MoneyMode) =>
  mode === "live" ? "www.peragus.com.br" : "peragussvm-staging.up.railway.app";

export const PROGRAM_ID = "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w";

export const short = (value: string, size = 7) =>
  value.length <= size * 2 + 1 ? value : `${value.slice(0, size)}…${value.slice(-size)}`;

/** Solana explorer cluster of a money mode (same pairing as the backend's MoneyEnvironment). */
export const explorerCluster = (mode: MoneyMode) => (mode === "live" ? "mainnet-beta" : "devnet");
/**
 * Explorer links for the given mode (required). Customer screens pass the backend-reported mode
 * (or use the operation's own `explorer_url`); the legacy devnet demo passes "test" explicitly.
 */
export const explorerTx = (signature: string, mode: MoneyMode) =>
  `https://explorer.solana.com/tx/${signature}?cluster=${explorerCluster(mode)}`;
export const explorerAddress = (address: string, mode: MoneyMode) =>
  `https://explorer.solana.com/address/${address}?cluster=${explorerCluster(mode)}`;
/** True for exactly the explorer transaction link the backend builds for this mode. */
export const isExplorerTxUrl = (value: unknown, mode: MoneyMode): value is string =>
  typeof value === "string" &&
  new RegExp(
    `^https://explorer\\.solana\\.com/tx/[1-9A-HJ-NP-Za-km-z]{64,88}\\?cluster=${explorerCluster(mode)}$`,
  ).test(value);
