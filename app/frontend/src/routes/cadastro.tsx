import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { CustomerPublicLayout, CustomerNotice } from "@/components/peragus/customer-ui";
import { CustomerOnboarding } from "@/components/peragus/customer-onboarding";
import { useCustomerSession, signUpCustomer } from "@/lib/peragus/customer-session";
import { journeyRequest, journeyMessage } from "@/lib/peragus/journey";
export const Route = createFileRoute("/cadastro")({ component: RegistrationPage });
export function RegistrationPage() {
  const session = useCustomerSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const redemption = useRef<string | null>(null);
  async function submit() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (session.status === "authenticated" && session.accessToken) {
        redemption.current ??= crypto.randomUUID();
        await journeyRequest(session.accessToken, "v1/me/pilot-invite/redeem", "POST", {
          request_id: redemption.current,
          code,
          display_name: name,
        });
        await session.reloadIdentity();
        setCode("");
      } else {
        const checked = await journeyRequest<{ valid: boolean; environment: string }>(
          null,
          "registration/invite/check",
          "POST",
          {
            code,
            email: email.trim(),
          },
        );
        if (checked.valid !== true || checked.environment !== "test")
          throw new Error("Invalid invitation response");
        await signUpCustomer(email.trim(), password);
        setPassword("");
        setMessage(
          "Confira seu e-mail para confirmar a conta. Depois, entre e volte a esta página com o mesmo código para concluir o cadastro. O convite ainda não foi consumido.",
        );
      }
    } catch (e) {
      setError(journeyMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (session.status === "authenticated" && session.identity?.customer)
    return (
      <CustomerPublicLayout>
        <div className="customer-auth-card journey-wide">
          <span className="customer-eyebrow">COMPLETE SEU CADASTRO</span>
          <h1>Vamos conhecer você.</h1>
          <p>Dados, consentimento e verificação de identidade fazem parte do cadastro.</p>
          <CustomerOnboarding />
          <Link to="/app/minha-conta" className="customer-link">
            Voltar à minha conta
          </Link>
        </div>
      </CustomerPublicLayout>
    );
  return (
    <CustomerPublicLayout>
      <div className="customer-auth-card">
        <span className="customer-eyebrow">ACESSO POR CONVITE</span>
        <h1>Crie sua conta Peragus.</h1>
        <p>
          Informe o convite enviado pela nossa equipe. A verificação de identidade é obrigatória
          para completar o cadastro.
        </p>
        {error && (
          <div role="alert">
            <CustomerNotice kind="warning">{error}</CustomerNotice>
          </div>
        )}
        {message && <CustomerNotice>{message}</CustomerNotice>}
        {!message && (
          <form
            aria-busy={busy}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="customer-field">
              Código de convite
              <input
                required
                autoComplete="off"
                value={code}
                disabled={busy}
                onChange={(e) => {
                  setCode(e.target.value.trim());
                }}
                placeholder="pginv_…"
                minLength={49}
                maxLength={49}
              />
            </label>
            {session.status === "authenticated" ? (
              <>
                <p className="customer-muted">Conta confirmada: {session.identity?.user.email}</p>
                <label className="customer-field">
                  Nome de exibição
                  <input
                    required
                    minLength={2}
                    maxLength={160}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="customer-field">
                  E-mail
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="customer-field">
                  Senha
                  <input
                    required
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    aria-describedby="signup-password-help"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <small id="signup-password-help">Use pelo menos 12 caracteres.</small>
              </>
            )}
            <button
              className="customer-button"
              type="submit"
              disabled={busy || !session.configured}
            >
              {busy
                ? "Processando…"
                : session.status === "authenticated"
                  ? "Validar convite e continuar"
                  : "Criar minha conta"}
            </button>
          </form>
        )}
        {message && (
          <Link className="customer-button" to="/login">
            Entrar após confirmar e-mail
          </Link>
        )}
        <p className="customer-muted">
          O convite é validado pelo servidor e vinculado ao seu e-mail. Não compartilhe seu código.
          Ambiente de testes, sem dinheiro real.
        </p>
        <Link className="customer-link" to="/login">
          Já tenho conta · Entrar
        </Link>
      </div>
    </CustomerPublicLayout>
  );
}
