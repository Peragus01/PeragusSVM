import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ClipboardList,
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
export function PeragusBrand() {
  return (
    <span className="customer-brand">
      <span className="customer-mark" aria-hidden="true">
        P
      </span>
      <span>
        <b>PERAGUS</b>
        <small>PAYMENT INFRASTRUCTURE</small>
      </span>
    </span>
  );
}
const NAV = [
  { path: "/app" as const, label: "Visão geral", icon: LayoutDashboard, group: "Sua conta" },
  { path: "/app/comprar-usdt" as const, label: "Comprar USDT", icon: ShoppingBag, group: "" },
  { path: "/app/operacoes" as const, label: "Operações", icon: ClipboardList, group: "" },
  {
    path: "/app/carteira" as const,
    label: "Carteira",
    icon: Wallet,
    group: "Cadastro e segurança",
  },
  { path: "/app/minha-conta" as const, label: "Minha conta e KYC", icon: UserRound, group: "" },
  { path: "/app/auditoria" as const, label: "Evidências", icon: ShieldCheck, group: "" },
];
export function CustomerLayout() {
  const session = useCustomerSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(max-width: 800px)");
    const sync = () => setMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (session.status === "unauthenticated") void navigate({ to: "/login", replace: true });
  }, [session.status, navigate]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
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
  return (
    <div className="customer-app">
      <a href="#conteudo" className="peragus-skip">
        Ir para o conteúdo
      </a>
      {open && (
        <button
          type="button"
          aria-label="Fechar navegação"
          className="customer-scrim"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={"customer-sidebar" + (open ? " is-open" : "")} inert={mobile && !open}>
        <div className="customer-sidebar-brand">
          <Link to="/app" aria-label="Peragus — sua conta">
            <PeragusBrand />
          </Link>
          <button
            type="button"
            className="customer-close"
            aria-label="Fechar menu"
            onClick={() => setOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav aria-label="Navegação do cliente" className="customer-nav">
          {NAV.map(({ path, label, icon: Icon, group }) => (
            <div key={path}>
              {group && <div className="customer-nav-caption">{group}</div>}
              <Link
                to={path}
                activeOptions={{ exact: path === "/app" }}
                activeProps={{ className: "active", "aria-current": "page" }}
                onClick={() => setOpen(false)}
              >
                <Icon size={19} />
                {label}
              </Link>
            </div>
          ))}
        </nav>
        <div className="customer-sidebar-footer">
          <ShieldCheck size={20} /> <b>Você está no sandbox</b>
          <p>Explore o piloto sem movimentar dinheiro real.</p>
          <Link to="/" className="customer-link">
            Conheça a Peragus <ArrowRight size={14} />
          </Link>
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
          <Link className="customer-breadcrumb" to="/app">
            Minha Peragus
          </Link>
          <div className="customer-top-actions">
            <span className="customer-environment">Sandbox · ambiente de testes</span>
            <Link to="/app/comprar-usdt" className="customer-top-buy customer-button">
              Comprar USDT <ArrowRight size={15} />
            </Link>
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
        <main className="customer-page" id="conteudo">
          <Outlet />
        </main>
        <footer className="customer-footer">
          © Peragus · Sua conta, com clareza em cada etapa.
          <span>Ambiente de testes · sem operações reais</span>
        </footer>
      </div>
    </div>
  );
}
export function CustomerPublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="customer-public">
      <header className="customer-public-header">
        <Link to="/" aria-label="Peragus — início">
          <PeragusBrand />
        </Link>
        <Link to="/" className="customer-link">
          Voltar ao início <ArrowRight size={16} />
        </Link>
      </header>
      <main className="customer-public-main">
        <div className="customer-auth-column">{children}</div>
        <aside className="customer-auth-story" aria-label="Conheça a Peragus">
          <img src="/peragus-life.webp" alt="" width="1672" height="941" />
          <div>
            <span className="customer-eyebrow">CONEXÕES QUE APROXIMAM</span>
            <h2>
              Mais possibilidades.
              <br />
              <em>Menos fronteiras.</em>
            </h2>
            <p>
              Uma nova experiência para conectar reais, stablecoins e negócios na América Latina.
            </p>
            <span className="customer-story-note">Piloto fechado · ambiente de testes</span>
          </div>
        </aside>
      </main>
      <footer className="customer-auth-footer">
        © Peragus · Nunca compartilhe sua senha ou a frase de recuperação da sua carteira.
      </footer>
    </div>
  );
}
