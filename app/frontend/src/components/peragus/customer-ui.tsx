import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ClipboardList,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  ShieldCheck,
  ShoppingBag,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import "@/customer.css";

export function SectionTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="customer-heading">
      <div>
        <span className="customer-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function CustomerPanel({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="customer-panel">
      {title && (
        <div className="customer-panel-title">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      <div className="customer-panel-body">{children}</div>
    </section>
  );
}
export function CustomerNotice({
  children,
  kind = "info",
}: {
  children: ReactNode;
  kind?: "info" | "warning" | "danger";
}) {
  return (
    <div role="status" className={"customer-notice customer-notice-" + kind}>
      {children}
    </div>
  );
}
export function CustomerEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="customer-empty">
      <ShieldCheck size={26} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
const NAV = [
  { path: "/" as const, label: "Institucional", icon: Home },
  { path: "/app" as const, label: "Visão geral", icon: LayoutDashboard },
  { path: "/app/operacoes" as const, label: "Operações", icon: ClipboardList },
  { path: "/app/comprar-usdt" as const, label: "Comprar USDT", icon: ShoppingBag },
  { path: "/app/carteira" as const, label: "Carteira e identidade", icon: Wallet },
  { path: "/app/auditoria" as const, label: "Auditoria", icon: ShieldCheck },
  { path: "/app/minha-conta" as const, label: "Minha conta", icon: UserRound },
];
export function CustomerLayout() {
  const session = useCustomerSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (session.status === "unauthenticated") void navigate({ to: "/login", replace: true });
  }, [session.status, navigate]);
  if (session.status !== "authenticated" || !session.identity) {
    return (
      <div className="customer-fullscreen">
        <div className="customer-loading" role="status">
          Verificando acesso à conta…
        </div>
      </div>
    );
  }
  return (
    <div className="customer-app">
      {open && (
        <button
          type="button"
          aria-label="Fechar navegação"
          className="customer-scrim"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={"customer-sidebar" + (open ? " is-open" : "")}>
        <div className="customer-brand">
          <span className="customer-mark">P</span>
          <span>
            <b>PERAGUS</b>
            <small>PAYMENT INFRASTRUCTURE</small>
          </span>
          <button
            type="button"
            className="customer-close"
            aria-label="Fechar menu"
            onClick={() => setOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="customer-nav-caption">PLATAFORMA</div>
        <nav aria-label="Navegação do cliente" className="customer-nav">
          {NAV.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              activeOptions={{ exact: path === "/" || path === "/app" }}
              activeProps={{ className: "active" }}
              onClick={() => setOpen(false)}
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="customer-sidebar-footer">
          <div className="customer-live-dot" /> Ambiente controlado{" "}
          <p>Operações financeiras não habilitadas neste frontend.</p>
        </div>
      </aside>
      <div className="customer-main">
        <header className="customer-topbar">
          <button
            type="button"
            aria-label="Abrir navegação"
            className="customer-menu"
            onClick={() => setOpen(true)}
          >
            <Menu size={20} />
          </button>
          <span className="customer-breadcrumb">PERAGUS / CONTA</span>
          <div className="customer-top-actions">
            <span className="customer-environment">SANDBOX · SEM OPERAÇÕES REAIS</span>
            <span className="customer-avatar" aria-label="Sessão autenticada">
              {session.identity.user.email.slice(0, 1).toUpperCase()}
            </span>
            <button
              type="button"
              className="customer-icon-button"
              aria-label="Encerrar sessão"
              title="Sair"
              onClick={() => {
                session.logout();
                void navigate({ to: "/login", replace: true });
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className="customer-page">
          <Outlet />
        </main>
        <footer className="customer-footer">
          Peragus • Segurança e transparência em cada etapa{" "}
          <span>Identidade confirmada pela API, nunca pela carteira</span>
        </footer>
      </div>
    </div>
  );
}
export function CustomerPublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="customer-public">
      <header className="customer-public-header">
        <Link to="/" className="customer-brand">
          <span className="customer-mark">P</span>
          <span>
            <b>PERAGUS</b>
            <small>PAYMENT INFRASTRUCTURE</small>
          </span>
        </Link>
        <Link to="/" className="customer-link">
          Voltar ao início <ArrowRight size={15} />
        </Link>
      </header>
      <main className="customer-public-main">{children}</main>
    </div>
  );
}
