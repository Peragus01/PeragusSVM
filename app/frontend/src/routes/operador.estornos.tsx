import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import {
  CustomerNotice,
  CustomerPanel,
  CustomerPublicLayout,
} from "@/components/peragus/customer-ui";
import { formatAmount } from "@/components/peragus/customer-operations";
import {
  listRefunds,
  decideRefund,
  refundLabels,
  RefundError,
  type OperatorRefund,
} from "@/lib/peragus/refunds";
export const Route = createFileRoute("/operador/estornos")({ component: OperatorRefundPage });
function OperatorRefundPage() {
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
      setError("Não foi possível entrar. Confira as credenciais da conta separada de operador.");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <CustomerPublicLayout>
      <div style={{ width: "min(100%, 1000px)" }}>
        <h1>Análise manual de estornos</h1>
        <p className="customer-muted">
          Ambiente sandbox. A aprovação registra uma decisão; nenhuma devolução é executada por esta
          tela.
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
            {session.identity?.customer !== null ? (
              <CustomerNotice kind="danger">
                Esta conta possui perfil de cliente. Saia e use uma conta separada de operador.
              </CustomerNotice>
            ) : (
              <OperatorQueue
                key={session.identity.user.id}
                token={session.accessToken!}
                verifyMfa={session.verifyOperatorMfa}
              />
            )}
          </>
        )}
        <Link className="customer-link" to="/login">
          Acesso do cliente
        </Link>
      </div>
    </CustomerPublicLayout>
  );
}
function OperatorQueue({
  token,
  verifyMfa,
}: {
  token: string;
  verifyMfa: (code: string) => Promise<void>;
}) {
  const [rows, setRows] = useState<OperatorRefund[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [next, setNext] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<OperatorRefund | null>(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setSelected(null);
    setLoading(true);
    setError("");
    setMfa(false);
    setNext(null);
    void listRefunds(token, cursor, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setRows(page.data);
          setNext(page.nextCursor);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setMfa(err instanceof RefundError && err.code === "WITHDRAWAL_OPERATOR_MFA_REQUIRED");
        setError(err instanceof RefundError ? err.message : "Consulta indisponível.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, cursor, revision]);
  async function confirm(event: FormEvent) {
    event.preventDefault();
    setVerifying(true);
    setError("");
    try {
      await verifyMfa(code);
      setRevision((value) => value + 1);
    } catch {
      setError("Não foi possível confirmar o autenticador. Use um código atual e tente novamente.");
    } finally {
      setCode("");
      setVerifying(false);
    }
  }
  return (
    <>
      {error && <CustomerNotice kind="warning">{error}</CustomerNotice>}
      {mfa && (
        <form onSubmit={(event) => void confirm(event)}>
          <label className="customer-field">
            Código do autenticador
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button className="customer-button" disabled={verifying}>
            {verifying ? "Verificando…" : "Confirmar MFA"}
          </button>
        </form>
      )}
      <CustomerPanel title="Pedidos de estorno">
        {loading && <p role="status">Consultando fila protegida…</p>}
        {!loading && !error && rows.length === 0 && <p>Nenhum pedido nesta página.</p>}
        {rows.map((row) => (
          <div className="customer-row" key={row.id}>
            <span style={{ overflowWrap: "anywhere" }}>
              {row.id}
              <br />
              {refundLabels[row.state]} · {formatAmount(row.requested_amount.amount, "BRL")}
            </span>
            <button
              type="button"
              className="customer-button-secondary"
              onClick={() => setSelected(row)}
            >
              Analisar pedido
            </button>
          </div>
        ))}
        <div className="customer-row">
          <button
            type="button"
            className="customer-button-secondary"
            disabled={loading}
            onClick={() => {
              setCursor(undefined);
              setRevision((value) => value + 1);
            }}
          >
            Atualizar fila
          </button>
          {next && (
            <button
              type="button"
              className="customer-button-secondary"
              disabled={loading}
              onClick={() => setCursor(next)}
            >
              Próxima página
            </button>
          )}
        </div>
      </CustomerPanel>
      {selected && (
        <RefundDecision
          key={selected.id}
          token={token}
          record={selected}
          onSaved={(value) => {
            setSelected(value);
            setRows((current) => current.map((row) => (row.id === value.id ? value : row)));
          }}
        />
      )}
    </>
  );
}
function RefundDecision({
  token,
  record,
  onSaved,
}: {
  token: string;
  record: OperatorRefund;
  onSaved: (value: OperatorRefund) => void;
}) {
  const [decision, setDecision] = useState<"approved" | "rejected">("rejected");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{ id: string; decision: "approved" | "rejected"; reason: string } | null>(
    null,
  );
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    const body = pending.current ?? { id: crypto.randomUUID(), decision, reason: reason.trim() };
    pending.current = body;
    try {
      const saved = await decideRefund(
        token,
        record.id,
        body.id,
        body.decision,
        body.reason,
        abort.signal,
      );
      if (!abort.signal.aborted) onSaved(saved);
    } catch (err) {
      if (!abort.signal.aborted)
        setError(
          err instanceof RefundError ? err.message : "Atualize a fila para consultar o resultado.",
        );
    } finally {
      if (!abort.signal.aborted) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <CustomerPanel title="Revisão do pedido">
      <p style={{ overflowWrap: "anywhere" }}>{record.reason}</p>
      <p>
        <strong>{refundLabels[record.state]}</strong>
      </p>
      {record.withdrawal_context.requires_manual_funds_review && (
        <CustomerNotice kind="warning">
          A retirada já foi iniciada. Confira a situação dos fundos e a transferência original antes
          de decidir. Este pedido não cancela a retirada.
        </CustomerNotice>
      )}
      {record.decision && <p>Motivo interno: {record.decision.reason}</p>}
      {record.returned_amount && (
        <p>Devolução registrada: {formatAmount(record.returned_amount.amount, "BRL")}</p>
      )}
      {error && <CustomerNotice kind="warning">{error}</CustomerNotice>}
      {record.state === "pending_review" && (
        <form onSubmit={(event) => void submit(event)}>
          <label className="customer-field">
            Decisão
            <select
              value={decision}
              disabled={busy || !!pending.current}
              onChange={(event) => setDecision(event.target.value as "approved" | "rejected")}
            >
              <option value="rejected">Não aprovar</option>
              <option value="approved">Aprovar análise</option>
            </select>
          </label>
          <label className="customer-field">
            Motivo interno
            <input
              minLength={10}
              maxLength={300}
              required
              value={reason}
              disabled={busy || !!pending.current}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            Conferi o pagamento e a retirada. Esta decisão não realiza uma devolução.
          </label>
          <button
            className="customer-button"
            disabled={busy || !confirmed || reason.trim().length < 10}
          >
            {busy
              ? "Registrando decisão…"
              : pending.current
                ? "Repetir mesma decisão"
                : "Registrar decisão"}
          </button>
        </form>
      )}
      {record.state === "approved" && (
        <CustomerNotice>
          Devolução pendente. A execução externa e o registro de conclusão continuam manuais.
        </CustomerNotice>
      )}
    </CustomerPanel>
  );
}
