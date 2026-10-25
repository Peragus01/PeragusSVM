import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
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
  kind?: "info" | "warning" | "danger" | "success";
}) {
  return (
    <div
      role={kind === "danger" ? "alert" : "status"}
      className={"customer-notice customer-notice-" + kind}
    >
      {children}
    </div>
  );
}
export function CustomerEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="customer-empty">
      <ShieldCheck size={26} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

type CustomerNavItem = {
  path:
    | "/"
    | "/app"
    | "/app/operacoes"
    | "/app/comprar-usdt"
    | "/app/carteira"
    | "/app/minha-conta"
    | "/app/auditoria";
  label: string;
  icon: LucideIcon;
  highlight?: boolean;
};
const NAV_GROUPS: { title: string; items: CustomerNavItem[] }[] = [
  {
    title: "PRINCIPAL",
    items: [
      { path: "/" as const, label: "Institucional", icon: Home },
      { path: "/app" as const, label: "Visão geral", icon: LayoutDashboard },
      { path: "/app/operacoes" as const, label: "Operações", icon: ClipboardList },
      {
        path: "/app/comprar-usdt" as const,
        label: "Comprar USDT",
        icon: ShoppingBag,
        highlight: true,
      },
    ],
  },
  {
    title: "CONTA E TRANSPARÊNCIA",
    items: [
      { path: "/app/carteira" as const, label: "Carteira e identidade", icon: Wallet },
      { path: "/app/minha-conta" as const, label: "Minha conta", icon: UserRound },
      { path: "/app/auditoria" as const, label: "Auditoria", icon: ShieldCheck },
    ],
  },
];
const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export function CustomerLayout() {
  const session = useCustomerSession();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (session.status === "unauthenticated") void navigate({ to: "/login", replace: true });
  }, [session.status, navigate]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
      if (event.key === "Tab") {
        const panel = document.getElementById("customer-navigation");
        const elements = Array.from(
          panel?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled)") ?? [],
        );
        const first = elements[0];
        const last = elements.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open]);

  if (session.status !== "authenticated" || !session.identity) {
    return (
      <div className="customer-fullscreen">
        <div className="customer-loading" role="status">
          Verificando acesso à conta…
        </div>
      </div>
    );
  }

  const currentName =
    NAV_ITEMS.find((item) => item.path === pathname)?.label ??
    (pathname.startsWith("/app/operacoes/") ? "Detalhes da operação" : "Minha conta");

  return (
    <div className="customer-app">
      <a className="customer-skip" href="#customer-main-content">
        Ir para o conteúdo principal
      </a>
      {open && (
        <button
          type="button"
          aria-label="Fechar navegação"
          className="customer-scrim"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        id="customer-navigation"
        aria-label="Menu de navegação"
        className={"customer-sidebar" + (open ? " is-open" : "")}
      >
        <div className="customer-brand">
          <span className="customer-mark">P</span>
          <span>
            <b>PERAGUS</b>
            <small>PAYMENT INFRASTRUCTURE</small>
          </span>
          <button
            ref={closeButton}
            type="button"
            className="customer-close"
            aria-label="Fechar menu"
            onClick={() => setOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="customer-nav-caption">{group.title}</div>
            <nav className="customer-nav" aria-label={group.title}>
              {group.items.map(({ path, label, icon: Icon, highlight }) => {
                return (
                  <Link
                    key={path}
                    to={path}
                    activeOptions={{ exact: path === "/" || path === "/app" }}
                    activeProps={{ className: "active" }}
                    className={highlight ? "customer-nav-purchase" : ""}
                    onClick={() => setOpen(false)}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{label}</span>
                    {highlight && <small className="customer-nav-tag">Prévia</small>}
                  </Link>
                );
              })}
            </nav>
          </div>
        ))}
        <div className="customer-sidebar-footer">
          <span className="customer-live-dot" /> Ambiente de testes
          <p>Compras e pagamentos Pix ainda não estão habilitados.</p>
        </div>
      </aside>
      <div className="customer-main">
        <header className="customer-topbar">
          <button
            ref={menuButton}
            type="button"
            aria-label="Abrir navegação"
            aria-expanded={open}
            aria-controls="customer-navigation"
            className="customer-menu"
            onClick={() => setOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <span className="customer-breadcrumb">PERAGUS / {currentName}</span>
          <div className="customer-top-actions">
            <span className="customer-environment">
              SANDBOX <span className="customer-env-long">· SEM TRANSAÇÕES REAIS</span>
            </span>
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
              <LogOut size={17} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main id="customer-main-content" className="customer-page" tabIndex={-1}>
          <Outlet />
        </main>
        <footer className="customer-footer">
          Peragus • Clareza e segurança em cada etapa
          <span>Transações dependem de autorização do servidor</span>
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
