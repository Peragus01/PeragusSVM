import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import {
  CustomerNotice,
  CustomerPanel,
  CustomerPublicLayout,
} from "@/components/peragus/customer-ui";
import { CustomerSessionError, useCustomerSession } from "@/lib/peragus/customer-session";
import type { OperatorMfaEnrollment } from "@/lib/peragus/customer-session-context";
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
  email_delivery?: {
    state: "pending" | "sending" | "uncertain" | "accepted" | "delivered" | "failed" | "cancelled";
    retry_blocked: boolean;
    accepted_at: string | null;
    delivered_at: string | null;
    last_error: string | null;
  } | null;
};
function deliveryLabel(delivery: Invite["email_delivery"]) {
  if (!delivery) return "Sem envio automático registrado";
  if (delivery.state === "uncertain" && delivery.retry_blocked)
    return "Resultado incerto · repetição automática bloqueada; consulte o suporte";
  return {
    pending: "E-mail na fila · ainda não enviado",
    sending: "Envio em andamento · aceitação ainda não confirmada",
    uncertain: "Resultado incerto · verificação pendente",
    accepted: "Aceito pelo Resend · entrega ainda não confirmada",
    delivered: "Entrega confirmada pelo provedor",
    failed: "Falha no envio ou na entrega",
    cancelled: "Envio cancelado",
  }[delivery.state];
}
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
              <InviteConsole
                token={session.accessToken}
                verifyMfa={session.verifyOperatorMfa}
                enrollMfa={session.enrollOperatorMfa}
                verifyMfaEnrollment={session.verifyOperatorMfaEnrollment}
              />
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

export function InviteConsole({
  token,
  verifyMfa,
  enrollMfa,
  verifyMfaEnrollment,
}: {
  token: string;
  verifyMfa: (code: string) => Promise<void>;
  enrollMfa?: () => Promise<OperatorMfaEnrollment>;
  verifyMfaEnrollment?: (factorId: string, code: string) => Promise<void>;
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
  const [mfaEnrollment, setMfaEnrollment] = useState<OperatorMfaEnrollment | null>(null);
  const [mfaSecretCopied, setMfaSecretCopied] = useState(false);
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
      if (mfaEnrollment) {
        if (!verifyMfaEnrollment)
          throw new CustomerSessionError("MFA_REQUIRED", "Cadastro indisponível.");
        await verifyMfaEnrollment(mfaEnrollment.factorId, mfaCode);
      } else {
        await verifyMfa(mfaCode);
      }
      setMfaNeeded(false);
      setMfaCode("");
      setMfaEnrollment(null);
      setInfo("MFA confirmado. Você já pode gerar o convite ou atualizar o histórico.");
    } catch (err) {
      setError(
        err instanceof CustomerSessionError && err.code === "MFA_REQUIRED"
          ? err.message
          : "Não foi possível confirmar o MFA. Verifique o código e tente novamente.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function startMfaEnrollment() {
    if (!enrollMfa || busy) return;
    setBusy(true);
    setError("");
    setMfaSecretCopied(false);
    try {
      setMfaEnrollment(await enrollMfa());
      setInfo("Escaneie o QR code e confirme o primeiro código antes de sair desta página.");
    } catch (err) {
      setError(
        err instanceof CustomerSessionError
          ? err.message
          : "Não foi possível cadastrar o autenticador.",
      );
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
      // Automatic delivery never returns the code or recipient in invitation history.
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
        if ([400, 401, 403, 404, 409, 422, 429].includes(response.status)) pending.current = null;
        throw new JourneyError(payload.error?.code ?? "UNAVAILABLE");
      }
      if (!payload.data) throw new JourneyError("INVALID_RESPONSE");
      if (payload.data.email_delivery) {
        setCreated(null);
        setInfo(
          `Convite registrado. ${deliveryLabel(payload.data.email_delivery)}. O destinatário recebe o código e o link de cadastro por e-mail.`,
        );
      } else if (payload.code) {
        setCreated({ code: payload.code, record: payload.data });
        setInfo(
          "Convite gerado. Copie o código agora: por segurança ele não poderá ser recuperado depois.",
        );
      } else {
        setCreated(null);
        setInfo("Solicitação já processada. Consulte o histórico para acompanhar o convite.");
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
          {!mfaEnrollment && enrollMfa && (
            <>
              <p className="customer-muted">
                Se esta é a primeira entrada desta conta de operador, cadastre um aplicativo
                autenticador antes de informar o código.
              </p>
              <button
                type="button"
                className="customer-button-secondary"
                disabled={busy}
                onClick={() => void startMfaEnrollment()}
              >
                Configurar autenticador
              </button>
            </>
          )}
          {mfaEnrollment && (
            <div className="customer-mfa-enrollment">
              <div className="customer-mfa-qr">
                <img
                  src={mfaEnrollment.qrCode}
                  width={280}
                  height={280}
                  alt="QR code para cadastrar o autenticador"
                  draggable={false}
                />
              </div>
              <p className="customer-muted">
                No Microsoft Authenticator, escolha <b>Outra conta</b>. No Google Authenticator,
                toque em <b>+</b> e depois em <b>Ler um QR code</b>.
              </p>
              {mfaEnrollment.secret && (
                <div className="customer-mfa-secret">
                  <label htmlFor="operator-mfa-secret">Chave manual</label>
                  <div>
                    <input
                      id="operator-mfa-secret"
                      readOnly
                      spellCheck={false}
                      autoComplete="off"
                      value={mfaEnrollment.secret}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      className="customer-button-secondary"
                      onClick={() => {
                        if (!navigator.clipboard) {
                          document.getElementById("operator-mfa-secret")?.focus();
                          return;
                        }
                        void navigator.clipboard
                          .writeText(mfaEnrollment.secret ?? "")
                          .then(() => setMfaSecretCopied(true))
                          .catch(() => {
                            setMfaSecretCopied(false);
                            document.getElementById("operator-mfa-secret")?.focus();
                          });
                      }}
                    >
                      {mfaSecretCopied ? "Chave copiada" : "Copiar chave"}
                    </button>
                  </div>
                  <small>Use somente as letras e os números exibidos, sem espaços.</small>
                </div>
              )}
              <p className="customer-muted">
                Esta chave é confidencial. Não envie, não registre em chamados e não salve em texto
                aberto. Depois de escanear, informe abaixo o código de seis dígitos.
              </p>
            </div>
          )}
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
              {mfaEnrollment ? "Ativar MFA" : "Confirmar MFA"}
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
              <strong>{deliveryLabel(item.email_delivery)}</strong>
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
