import { Link } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  CustomerNotice,
  CustomerPanel,
  CustomerPublicLayout,
} from "@/components/peragus/customer-ui";
import { OperatorMfaPanel, useOperatorStatus } from "@/components/peragus/operator-mfa";
import {
  isMfaGate,
  OperatorErrorNotice,
  type OperatorScreenProps,
} from "@/components/peragus/operator-actions";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import type { OperatorMfaEnrollment } from "@/lib/peragus/customer-session-context";
import { useMoneyMode } from "@/lib/peragus/config";
import type { OperatorApiError } from "@/lib/peragus/operator-console";
import "@/operator.css";

export interface OperatorContext extends OperatorScreenProps {
  enrollMfa?: (() => Promise<OperatorMfaEnrollment>) | undefined;
  verifyMfaEnrollment?: ((factorId: string, code: string) => Promise<void>) | undefined;
}

const links = [
  { to: "/operador", label: "Painel" },
  { to: "/operador/controles", label: "Controles" },
  { to: "/operador/revisao-diaria", label: "Revisão diária" },
  { to: "/operador/saques", label: "Saques" },
  { to: "/operador/estornos", label: "Estornos" },
  { to: "/operador/alertas", label: "Alertas" },
  { to: "/operador/convites", label: "Convites" },
] as const;
export function OperatorNav() {
  return (
    <nav aria-label="Console do operador" className="operator-nav">
      {links.map((link) => (
        <Link key={link.to} className="customer-link" to={link.to}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Operator area layout: separate operator login, refusal of customer accounts, navigation.
 * Authorization itself is the backend's (allowlist + AAL2 + fresh MFA where required).
 */
export function OperatorShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: (context: OperatorContext) => ReactNode;
}) {
  const session = useCustomerSession();
  const mode = useMoneyMode();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await session.login(email.trim(), password);
    } catch {
      setError("Não foi possível entrar. Confira as credenciais da conta separada de operador.");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <CustomerPublicLayout>
      <div style={{ width: "min(100%, 1000px)" }}>
        <OperatorNav />
        <h1>{title}</h1>
        <p className="customer-muted">
          {mode === "live"
            ? "Produção: ações de envio movem dinheiro real."
            : "Ambiente de testes (sandbox/devnet)."}
          {description ? ` ${description}` : ""}
        </p>
        {session.status !== "authenticated" ? (
          <CustomerPanel title="Acesso do operador">
            {error && <CustomerNotice kind="danger">{error}</CustomerNotice>}
            <form onSubmit={(event) => void login(event)}>
              <label className="customer-field">
                E-mail do operador
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="customer-field">
                Senha
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                className="customer-button"
                disabled={busy || session.status === "loading" || !session.configured}
              >
                Entrar como operador
              </button>
            </form>
          </CustomerPanel>
        ) : (
          <>
            <button type="button" className="customer-button-secondary" onClick={session.logout}>
              Encerrar sessão
            </button>
            {session.identity?.customer !== null || !session.accessToken ? (
              <CustomerNotice kind="danger">
                Esta conta possui perfil de cliente. Saia e use uma conta separada de operador.
              </CustomerNotice>
            ) : (
              children({
                token: session.accessToken,
                verifyMfa: session.verifyOperatorMfa,
                enrollMfa: session.enrollOperatorMfa,
                verifyMfaEnrollment: session.verifyOperatorMfaEnrollment,
              })
            )}
          </>
        )}
      </div>
    </CustomerPublicLayout>
  );
}

/** MFA panel for a read; offers enrollment only to backend-confirmed operators. */
function GatedMfaPanel({
  context,
  onVerified,
}: {
  context: OperatorContext;
  onVerified: (token?: string) => void;
}) {
  const operator = useOperatorStatus(context.enrollMfa ? context.token : null);
  return (
    <OperatorMfaPanel
      verifyMfa={context.verifyMfa}
      enrollMfa={operator === true ? context.enrollMfa : undefined}
      verifyMfaEnrollment={context.verifyMfaEnrollment}
      onVerified={onVerified}
    />
  );
}
type Read<T> = {
  data: T | null;
  error: OperatorApiError | null;
  loading: boolean;
  reload: (token?: string) => void;
};
/**
 * One MFA panel for every read of a screen answered with WITHDRAWAL_OPERATOR_MFA_REQUIRED /
 * OPERATOR_MFA_STALE; after the confirmation those reads reload with the new token.
 */
export function OperatorMfaGate({
  reads,
  context,
}: {
  reads: Read<unknown>[];
  context: OperatorContext;
}) {
  const gated = reads.filter((read) => isMfaGate(read.error));
  if (!gated.length) return null;
  return (
    <GatedMfaPanel
      context={context}
      onVerified={(fresh) => gated.forEach((read) => read.reload(fresh))}
    />
  );
}
/** Renders a read's state: the pt-BR error, the loading line or the children (MFA: see OperatorMfaGate). */
export function OperatorRead<T>({
  read,
  loadingText = "Consultando…",
  children,
}: {
  read: Read<T>;
  loadingText?: string;
  children: (data: T) => ReactNode;
}) {
  if (isMfaGate(read.error)) return null;
  if (read.error) return <OperatorErrorNotice error={read.error} />;
  if (read.data === null) return read.loading ? <p role="status">{loadingText}</p> : null;
  return <>{children(read.data)}</>;
}
