/** Public, non-secret runtime configuration. Vite variables are bundled into the browser. */
const env = import.meta.env as Record<string, string | undefined>;

export const config = {
  apiBaseUrl: (env["VITE_API_BASE_URL"] || "/api").replace(/\/$/, ""),
  solanaRpcUrl: env["VITE_SOLANA_RPC_URL"] || "https://api.devnet.solana.com",
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
export const moneyNetwork = (mode: MoneyMode): MoneyNetwork =>
  mode === "live" ? "solana:mainnet" : "solana:devnet";
/** Domain the backend binds into the wallet ownership proof for this mode. */
export const walletProofDomain = (mode: MoneyMode) =>
  mode === "live" ? "www.peragus.com.br" : "peragussvm-staging.up.railway.app";

export const PROGRAM_ID = "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w";

export const short = (value: string, size = 7) =>
  value.length <= size * 2 + 1 ? value : `${value.slice(0, size)}…${value.slice(-size)}`;

export const explorerTx = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
export const explorerAddress = (address: string) =>
  `https://explorer.solana.com/address/${address}?cluster=devnet`;
