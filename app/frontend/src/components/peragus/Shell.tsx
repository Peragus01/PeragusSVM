import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Braces,
  ExternalLink,
  Layers3,
  LayoutDashboard,
  Menu,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "./CopyButton";
import { ConnectionProvider } from "./connection";
import { WalletProvider } from "./Wallet";
import { PROGRAM_ID, explorerAddress, short } from "@/lib/peragus/config";
export function BrandMark() {
  return (
    <img
      src="/favicon.png"
      className="peragus-logo"
      width={48}
      height={32}
      alt=""
      aria-hidden="true"
    />
  );
}
function Header() {
  const [menu, setMenu] = useState(false);
  return (
    <>
      <header className="app-header">
        <Link to="/" className="brand">
          <BrandMark />
          <span>Peragus</span>
        </Link>
        <span className="header-divider" />
        <span className="header-caption">
          SETTLEMENT CONTROL ROOM<span>LATAM SVM INFRASTRUCTURE</span>
        </span>
        <div className="wallet-space" />
        <Button
          variant="ghost"
          size="icon"
          className="mobile-menu-button"
          aria-label={menu ? "Close navigation" : "Open navigation"}
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X /> : <Menu />}
        </Button>
      </header>
      <div className={`navigation-bar ${menu ? "nav-open" : ""}`}>
        <nav aria-label="Main navigation">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            activeProps={{ className: "nav-active" }}
            onClick={() => setMenu(false)}
          >
            <LayoutDashboard />
            Overview
          </Link>
          <Link
            to="/settlements"
            activeProps={{ className: "nav-active" }}
            onClick={() => setMenu(false)}
          >
            <Layers3 />
            Settlement
          </Link>
          <Link
            to="/developers"
            activeProps={{ className: "nav-active" }}
            onClick={() => setMenu(false)}
          >
            <Braces />
            API
          </Link>
        </nav>
        <span className="hackathon-label">
          <span className="tiny-square" />
          SOLANA GLOBAL HACKATHON <span>2026</span>
          <ArrowUpRight />
        </span>
      </div>
    </>
  );
}
function Footer() {
  return (
    <footer className="app-footer">
      <div>
        <Link to="/" className="brand footer-brand">
          <BrandMark />
          <span>Peragus</span>
        </Link>
        <span>Institutional payments. Verifiable settlement.</span>
      </div>
      <div className="footer-program">
        <span>DEVNET PROGRAM</span>
        <a href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noreferrer">
          <code>{short(PROGRAM_ID, 9)}</code>
          <ExternalLink className="size-3" />
        </a>
        <CopyButton value={PROGRAM_ID} label="Copy Solana program ID" />
      </div>
      <span className="footer-note">DEVNET ONLY · NO MAINNET FUNDS</span>
    </footer>
  );
}
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider>
      <WalletProvider>
        <div className="app-shell">
          <Header />
          <main>{children}</main>
          <Footer />
        </div>
      </WalletProvider>
    </ConnectionProvider>
  );
}
