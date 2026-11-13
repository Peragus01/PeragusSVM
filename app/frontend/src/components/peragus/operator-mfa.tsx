import { useEffect, useState, type FormEvent } from "react";
import { CustomerNotice, CustomerPanel } from "@/components/peragus/customer-ui";
import { CustomerSessionError, fetchOperatorStatus } from "@/lib/peragus/customer-session-auth";
import type { OperatorMfaEnrollment } from "@/lib/peragus/customer-session-context";

/** true/false once GET /v1/admin/operator-status answered; null while asking. Fails closed. */
export function useOperatorStatus(token: string | null): boolean | null {
  const [state, setState] = useState<{ token: string; operator: boolean } | null>(null);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void fetchOperatorStatus(token, controller.signal).then((operator) => {
      if (!controller.signal.aborted) setState({ token, operator });
    });
    return () => controller.abort();
  }, [token]);
  return state?.token === token ? state.operator : null;
}

/**
 * MFA confirmation for operator screens. Offers TOTP enrollment only when `enrollMfa` is
 * given (the caller passes it only to backend-confirmed operators). `onVerified` receives
 * the new access token when the session returned one.
 */
export function OperatorMfaPanel({
  verifyMfa,
  enrollMfa,
  verifyMfaEnrollment,
  onVerified,
}: {
  verifyMfa: (code: string) => Promise<unknown>;
  enrollMfa?: (() => Promise<OperatorMfaEnrollment>) | undefined;
  verifyMfaEnrollment?: ((factorId: string, code: string) => Promise<void>) | undefined;
  onVerified: (token?: string) => void;
}) {
  const [mfaCode, setMfaCode] = useState("");
  const [mfaEnrollment, setMfaEnrollment] = useState<OperatorMfaEnrollment | null>(null);
  const [mfaSecretCopied, setMfaSecretCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let fresh: unknown;
      if (mfaEnrollment) {
        if (!verifyMfaEnrollment)
          throw new CustomerSessionError("MFA_REQUIRED", "Cadastro indisponível.");
        await verifyMfaEnrollment(mfaEnrollment.factorId, mfaCode);
      } else {
        fresh = await verifyMfa(mfaCode);
      }
      setMfaEnrollment(null);
      onVerified(typeof fresh === "string" ? fresh : undefined);
    } catch (err) {
      setError(
        err instanceof CustomerSessionError && err.code === "MFA_REQUIRED"
          ? err.message
          : "Não foi possível confirmar o MFA. Verifique o código e tente novamente.",
      );
    } finally {
      setMfaCode("");
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
  return (
    <CustomerPanel title="Confirmar autenticação multifator">
      {error && <CustomerNotice kind="warning">{error}</CustomerNotice>}
      {info && <CustomerNotice>{info}</CustomerNotice>}
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
            No Microsoft Authenticator, escolha <b>Outra conta</b>. No Google Authenticator, toque
            em <b>+</b> e depois em <b>Ler um QR code</b>.
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
  );
}
