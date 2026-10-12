/** Public, non-secret runtime configuration. Vite variables are bundled into the browser. */
const env = import.meta.env as Record<string, string | undefined>;

export const config = {
  apiBaseUrl: (env["VITE_API_BASE_URL"] || "/api").replace(/\/$/, ""),
  solanaRpcUrl: env["VITE_SOLANA_RPC_URL"] || "https://api.devnet.solana.com",
  demoCorridorId: env["VITE_DEMO_CORRIDOR_ID"] || "",
  demoRecipientWallet: env["VITE_DEMO_RECIPIENT_WALLET"] || "",
  demoPayoutDestinationId: env["VITE_DEMO_PAYOUT_DESTINATION_ID"] || "",
};

export const PROGRAM_ID = "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w";

export const short = (value: string, size = 7) =>
  value.length <= size * 2 + 1 ? value : `${value.slice(0, size)}…${value.slice(-size)}`;

export const explorerTx = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
export const explorerAddress = (address: string) =>
  `https://explorer.solana.com/address/${address}?cluster=devnet`;
