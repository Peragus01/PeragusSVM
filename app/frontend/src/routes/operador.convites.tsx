import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import {
  CustomerNotice,
  CustomerPanel,
  CustomerPublicLayout,
} from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { journeyRequest, journeyMessage, JourneyError } from "@/lib/peragus/journey";

export const Route = createFileRoute("/operador/convites")({ component: OperatorInvitesPage });

type InviteState = "issued" | "redeemed" | "expired" | "revoked";
type Invite = {
  id: string;
  state: InviteState;
  slot: number;
  created_at: string;
  expires_at: string;
  reason: string;
  target_user_id: string | null;
};
type IssueResponse = { data: Invite; code: string | null; meta: { idempotent_replay: boolean } };

function OperatorInvitesPage() {
  const session = useCustomerSession();
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
      setError("Não foi possível entrar. Use a conta separada do operador.");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <CustomerPublicLayout>
      <div style={{ width: "min(100%, 980px)" }}>
        <h1>Gestão de convites</h1>
        <p className="customer-muted">
          Acesso restrito a operadores autorizados com autenticação multifator. Os convites são
          individuais, vinculados ao e-mail e válidos uma única vez.
        </p>
        {session.status !== "authenticated" ? (
          <CustomerPanel title="Acesso do operador">
            {error && <CustomerNotice kind="danger">{error}</CustomerNotice>}
            <form onSubmit={(event) => void login(event)}>
              <label className="customer-field">
                E-mail do operador
                <input
                  required
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="customer-field">
                Senha
                <input
                  required
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button className="customer-button" disabled={busy || !session.configured}>
                Entrar como operador
              </button>
            </form>
          </CustomerPanel>
        ) : (
          <>
            <button type="button" className="customer-button-secondary" onClick={session.logout}>
              Encerrar sessão
            </button>
            {session.identity?.customer !== null ||
            !session.identity?.user ||
            !session.accessToken ? (
              <CustomerNotice kind="danger">
                Esta área exige uma conta separada de operador, sem perfil de cliente.
              </CustomerNotice>
            ) : (
              <InviteConsole token={session.accessToken} verifyMfa={session.verifyOperatorMfa} />
            )}
          </>
        )}
        <p>
          <Link className="customer-link" to="/operador/estornos">
            Ir para estornos
          </Link>
        </p>
      </div>
    </CustomerPublicLayout>
  );
}

function InviteConsole({
  token,
  verifyMfa,
}: {
  token: string;
  verifyMfa: (code: string) => Promise<void>;
}) {
  const [targetEmail, setTargetEmail] = useState("");
  const [hours, setHours] = useState(24);
  const [reason, setReason] = useState("Convite autorizado pelo operador Peragus");
  const [created, setCreated] = useState<{ code: string; record: Invite } | null>(null);
  const [items, setItems] = useState<Invite[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [mfaNeeded, setMfaNeeded] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pending = useRef<{
    request_id: string;
    target_email: string;
    expires_in_hours: number;
    reason: string;
  } | null>(null);
  function handleError(err: unknown) {
    if (err instanceof JourneyError && err.code === "WITHDRAWAL_OPERATOR_MFA_REQUIRED") {
      setMfaNeeded(true);
      setError("Confirme a autenticação multifator para liberar a emissão de convites.");
      return;
    }
    setError(journeyMessage(err));
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const result = await journeyRequest<Invite[]>(token, "v1/admin/pilot-invites");
      setItems(result);
      setLoaded(true);
      setMfaNeeded(false);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await verifyMfa(mfaCode);
      setMfaNeeded(false);
      setMfaCode("");
      setInfo("MFA confirmado. Você já pode gerar o convite ou atualizar o histórico.");
    } catch {
      setError("Código MFA inválido ou expirado.");
    } finally {
      setBusy(false);
    }
  }
  async function issue(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const request = pending.current ?? {
        request_id: crypto.randomUUID(),
        target_email: targetEmail.trim().toLowerCase(),
        expires_in_hours: hours,
        reason: reason.trim(),
      };
      pending.current = request;
      // Issue response is deliberately the only place where the plaintext code appears.
      const response = await fetch("/api/v1/admin/pilot-invites", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(request),
      });
      const payload = (await response.json()) as {
        data?: Invite;
        code?: string | null;
        error?: { code?: string };
        meta?: { idempotent_replay?: boolean };
      };
      if (!response.ok) {
        // A definite client/auth rejection never issued a code. Only keep the
        // idempotency key if the operation's outcome might genuinely be unknown.
        if ([400, 401, 403, 404, 409, 422, 429].includes(response.status))
          pending.current = null;
        throw new JourneyError(payload.error?.code ?? "UNAVAILABLE");
      }
      if (!payload.data) throw new JourneyError("INVALID_RESPONSE");
      if (payload.code) {
        setCreated({ code: payload.code, record: payload.data });
        setInfo(
          "Convite gerado. Copie o código agora: por segurança ele não poderá ser recuperado depois.",
        );
      } else {
        setCreated(null);
        setInfo(
          "Solicitação já processada. O código não pode ser recuperado. Revogue o convite anterior e gere outro, se necessário.",
        );
      }
      pending.current = null;
      setTargetEmail("");
      await refresh();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(item: Invite) {
    const message = window.prompt("Motivo da revogação (mínimo 10 caracteres):");
    if (!message || message.trim().length < 10) return;
    if (!window.confirm("Revogar este convite? Esta ação não pode ser desfeita.")) return;
    setBusy(true);
    setError("");
    try {
      await journeyRequest(
        token,
        `v1/admin/pilot-invites/${encodeURIComponent(item.id)}/revoke`,
        "POST",
        { request_id: crypto.randomUUID(), reason: message.trim() },
      );
      await refresh();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <CustomerNotice kind="warning">{error}</CustomerNotice>}
      {info && <CustomerNotice>{info}</CustomerNotice>}
      {mfaNeeded && (
        <CustomerPanel title="Confirmar autenticação multifator">
          <form onSubmit={(event) => void verify(event)}>
            <label className="customer-field">
              Código do autenticador
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
              />
            </label>
            <button className="customer-button" disabled={busy}>
              Confirmar MFA
            </button>
          </form>
        </CustomerPanel>
      )}
      <CustomerPanel title="Emitir convite">
        <form onSubmit={(event) => void issue(event)}>
          <label className="customer-field">
            E-mail do convidado
            <input
              required
              type="email"
              maxLength={254}
              autoComplete="off"
              disabled={busy || !!pending.current}
              value={targetEmail}
              onChange={(event) => setTargetEmail(event.target.value)}
            />
          </label>
          <label className="customer-field">
            Validade
            <select
              value={hours}
              disabled={busy || !!pending.current}
              onChange={(event) => setHours(Number(event.target.value))}
            >
              <option value={24}>24 horas</option>
              <option value={48}>48 horas</option>
              <option value={72}>72 horas</option>
              <option value={168}>7 dias</option>
            </select>
          </label>
          <label className="customer-field">
            Justificativa interna
            <input
              required
              minLength={10}
              maxLength={300}
              disabled={busy || !!pending.current}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="customer-button"
            disabled={busy || mfaNeeded || !targetEmail.trim() || reason.trim().length < 10}
          >
            {busy ? "Processando…" : "Gerar convite"}
          </button>
        </form>
        {pending.current && (
          <p className="customer-muted">
            Resultado incerto: uma nova tentativa reutiliza a mesma chave de idempotência.
          </p>
        )}
        {created && (
          <div className="customer-row">
            <span style={{ overflowWrap: "anywhere" }}>
              <strong>Código emitido (única exibição):</strong> {created.code}
            </span>
            <button
              type="button"
              className="customer-button-secondary"
              onClick={() => void navigator.clipboard.writeText(created.code)}
            >
              Copiar código
            </button>
            <button
              type="button"
              className="customer-button-secondary"
              onClick={() => setCreated(null)}
            >
              Ocultar código
            </button>
          </div>
        )}
      </CustomerPanel>
      <CustomerPanel title="Histórico recente (últimos 50)">
        <button
          type="button"
          className="customer-button-secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Atualizar histórico
        </button>
        {!loaded && (
          <p className="customer-muted">Clique em atualizar para consultar os convites.</p>
        )}
        {loaded && items.length === 0 && <p>Nenhum convite encontrado.</p>}
        {items.map((item) => (
          <div className="customer-row" key={item.id}>
            <span style={{ overflowWrap: "anywhere" }}>
              <strong>{item.state}</strong> · {new Date(item.created_at).toLocaleString("pt-BR")}
              <br />
              ID: {item.id}
              <br />
              Validade: {new Date(item.expires_at).toLocaleString("pt-BR")}
              <br />
              {item.reason}
            </span>
            {item.state === "issued" && (
              <button
                type="button"
                className="customer-button-secondary"
                disabled={busy}
                onClick={() => void revoke(item)}
              >
                Revogar
              </button>
            )}
          </div>
        ))}
      </CustomerPanel>
    </>
  );
}
