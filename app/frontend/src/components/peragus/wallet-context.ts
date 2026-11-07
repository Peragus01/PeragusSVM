import { createContext, useContext } from "react";

type WalletState = {
  /** Connected Devnet public key; null immediately after disconnect. */
  address: string | null;
  open: () => void;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  /** Signs exact transaction bytes without broadcasting; returns the signed transaction bytes. */
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
};

export const WalletContext = createContext<WalletState>({
  address: null,
  open: () => {},
  signMessage: async () => {
    throw new Error("Connect a wallet with message signing support.");
  },
  signTransaction: async () => {
    throw new Error("Connect a Solana wallet first.");
  },
});
export const usePeragusWallet = () => useContext(WalletContext);
