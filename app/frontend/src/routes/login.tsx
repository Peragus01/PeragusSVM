import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CustomerPublicLayout, CustomerNotice } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { Eye, EyeOff, ArrowRight } from "lucide-react";
export const Route = createFileRoute("/login")({ component: LoginPage });
export function LoginPage() {
  const session = useCustomerSession();
  const navigate = useNavigate();
  const submitting = useRef(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (session.status === "authenticated") void navigate({ to: "/app", replace: true });
  }, [session.status, navigate]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await session.login(email.trim(), password);
      await navigate({ to: "/app" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível entrar.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <CustomerPublicLayout>
      <div className="customer-auth-card">
        <span className="customer-eyebrow">ACESSO À PERAGUS</span>
        <h1>Entre na sua conta.</h1>
        <p>Que bom ter você aqui. Entre para acompanhar suas operações e cuidar da sua conta.</p>
        {!session.configured && (
          <CustomerNotice kind="warning">
            O acesso está temporariamente indisponível neste ambiente. Tente novamente mais tarde.
          </CustomerNotice>
        )}
        {error && <CustomerNotice kind="danger">{error}</CustomerNotice>}
        <form aria-busy={busy} onSubmit={(e) => void submit(e)}>
          <label className="customer-field">
            E-mail
            <input
              required
              autoComplete="username"
              placeholder="voce@exemplo.com"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="customer-field">
            Senha
            <span className="customer-password-wrap">
              <input
                required
                autoComplete="current-password"
                type={visible ? "text" : "password"}
                placeholder="Sua senha"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
                aria-pressed={visible}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
            </span>
          </label>
          <button
            className="customer-button"
            style={{ width: "100%" }}
            disabled={!session.configured || busy}
            type="submit"
          >
            {busy ? (
              <>
                <span className="premium-spinner" aria-hidden="true" />
                Entrando…
              </>
            ) : (
              <>
                Entrar na Peragus <ArrowRight size={17} />
              </>
            )}
          </button>
        </form>
        <div className="customer-row">
          <Link className="customer-link" to="/recuperar-senha">
            Esqueci minha senha
          </Link>
        </div>
        <p className="customer-auth-divider">Primeiro acesso ao piloto?</p>
        <Link className="customer-button-secondary" to="/cadastro">
          Tenho um convite
        </Link>
        <Link className="customer-link customer-operator-link" to="/operador/estornos">
          Área do operador
        </Link>
        <p className="customer-muted customer-session-note">
          Por segurança, a sessão é mantida somente na memória. Recarregar a página exige novo
          login.
        </p>
      </div>
    </CustomerPublicLayout>
  );
}
