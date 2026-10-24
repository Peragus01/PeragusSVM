import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import {
  ChevronRight,
  ExternalLink,
  LogOut,
  ShieldCheck,
  Wallet as WalletIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { explorerAddress, short } from "@/lib/peragus/config";
import { WalletContext } from "./wallet-context";

const DEVNET = "solana:devnet";

export function WalletProvider({ children, showHeaderAction = true }: { children: ReactNode; showHeaderAction?: boolean }) {
  const [visible, setVisible] = useState(false);
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /** Bumped on every intentional connect, close, or disconnect; stale results compare against it. */
  const generation = useRef(0);
  const alive = useRef(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const registry = getWallets();
    const update = () =>
      setWallets(
        registry
          .get()
          .filter(
            (w) =>
              w.chains.some((chain) => chain.startsWith("solana:")) &&
              "standard:connect" in w.features,
          ),
      );
    update();
    const offRegister = registry.on("register", update);
    const offUnregister = registry.on("unregister", update);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  // Account events are only observed for the currently selected wallet; disconnect drops the listener.
  useEffect(() => {
    if (!wallet) return;
    const token = generation.current;
    const events = (wallet.features as Partial<StandardEventsFeature>)["standard:events"];
    return events?.on("change", ({ accounts }) => {
      if (generation.current !== token || !accounts) return;
      setAccount(accounts.find((a) => a.chains.includes(DEVNET)) ?? null);
    });
  }, [wallet]);

  useEffect(() => {
    if (!visible) return;
    const previous = document.body.style.overflow;
    const focused = document.activeElement;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        generation.current++;
        setBusy("");
        setVisible(false);
      }
      if (event.key === "Tab") {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>("[data-wallet-dialog] button:not(:disabled)"),
        );
        const first = nodes[0];
        const last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", keydown);
      if (focused instanceof HTMLElement) focused.focus();
    };
  }, [visible]);

  const close = () => {
    generation.current++;
    setBusy("");
    setVisible(false);
  };

  const disconnect = () => {
    const old = wallet;
    generation.current++;
    setAccount(null);
    setWallet(null);
    setBusy("");
    setError("");
    const feature = (old?.features as Partial<StandardDisconnectFeature> | undefined)?.[
      "standard:disconnect"
    ];
    if (feature)
      void Promise.resolve()
        .then(() => feature.disconnect())
        .catch(() => {});
  };

  const connect = async (selected: Wallet) => {
    const token = ++generation.current;
    setBusy(selected.name);
    setError("");
    try {
      const feature = (selected.features as Partial<StandardConnectFeature>)["standard:connect"];
      if (!feature) throw new Error("Wallet does not support standard connection.");
      const result = await feature.connect();
      if (!alive.current || generation.current !== token) return;
      const selectedAccount = result.accounts.find((a) => a.chains.includes(DEVNET));
      if (!selectedAccount) throw new Error("Enable Solana Devnet in your wallet, then reconnect.");
      setWallet(selected);
      setAccount(selectedAccount);
      setVisible(false);
    } catch (e) {
      if (alive.current && generation.current === token)
        setError(e instanceof Error ? e.message : "Wallet connection was declined.");
    } finally {
      if (alive.current && generation.current === token) setBusy("");
    }
  };

  const signTransaction = async (transaction: Uint8Array) => {
    if (!wallet || !account) throw new Error("Connect a Solana wallet first.");
    const feature = (wallet.features as Partial<SolanaSignTransactionFeature>)[
      "solana:signTransaction"
    ];
    if (!feature) throw new Error("This wallet cannot sign Solana transactions without sending.");
    const token = generation.current;
    const [result] = await feature.signTransaction({ account, chain: DEVNET, transaction });
    if (generation.current !== token) throw new Error("Wallet disconnected; signing cancelled.");
    if (!result) throw new Error("The wallet returned no signed transaction.");
    return result.signedTransaction;
  };

  const address = account?.address ?? null;
  return (
    <WalletContext.Provider
      value={{
        address,
        open: () => {
          setError("");
          setVisible(true);
        },
        signTransaction,
      }}
    >
      {children}
      {showHeaderAction && <div className="wallet-header-action">
        {address ? (
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" asChild>
              <a href={explorerAddress(address)} target="_blank" rel="noreferrer">
                <WalletIcon />
                <span data-testid="wallet-address">{short(address, 4)}</span>
                <ExternalLink />
              </a>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Disconnect wallet"
              title="Disconnect wallet"
              onClick={disconnect}
            >
              <LogOut />
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setVisible(true)}>
            <WalletIcon />
            Connect Wallet
          </Button>
        )}
      </div>}
      {visible &&
        createPortal(
          <div className="wallet-overlay" data-testid="wallet-overlay" onClick={close}>
            <div
              data-wallet-dialog
              role="dialog"
              aria-modal="true"
              aria-labelledby="wallet-title"
              className="wallet-dialog"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between">
                <div className="wallet-symbol">
                  <WalletIcon />
                </div>
                <Button
                  ref={closeRef}
                  variant="ghost"
                  size="icon"
                  aria-label="Close wallet dialog"
                  onClick={close}
                >
                  <X />
                </Button>
              </div>
              <h2 id="wallet-title" className="mt-5 text-2xl font-semibold">
                Connect to Peragus
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Select a Solana wallet. All settlement signing happens on Devnet.
              </p>
              <div className="mt-6 space-y-2">
                {wallets.map((w) => (
                  <Button
                    key={w.name}
                    variant="outline"
                    className="h-14 w-full justify-between"
                    disabled={Boolean(busy)}
                    onClick={() => void connect(w)}
                  >
                    <span className="flex items-center gap-3">
                      <img src={w.icon} alt="" className="size-7" />
                      {w.name}
                    </span>
                    {busy === w.name ? "Connecting…" : <ChevronRight />}
                  </Button>
                ))}
                {wallets.length === 0 && (
                  <div className="border border-border p-4 text-sm text-muted-foreground">
                    No Solana wallets detected. Open this page in a browser with a Wallet Standard
                    extension such as Phantom, Solflare, or Backpack.
                  </div>
                )}
              </div>
              {error && (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                <ShieldCheck className="size-4 text-primary" />
                Wallet Standard · Devnet only · No Mainnet funds
              </div>
            </div>
          </div>,
          document.body,
        )}
    </WalletContext.Provider>
  );
}
