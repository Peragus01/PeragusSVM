import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CustomerNotice, CustomerPanel } from "@/components/peragus/customer-ui";
import {
  FreshMfaForm,
  useFreshMfaAction,
  useOperatorRead,
} from "@/components/peragus/operator-actions";
import {
  OperatorMfaGate,
  OperatorRead,
  OperatorShell,
  type OperatorContext,
} from "@/components/peragus/operator-shell";
import {
  ApproveDialog,
  ExecuteDialog,
  ExecutionDetails,
  walletPrefix,
  type QueueIntent,
} from "@/components/peragus/operator-withdrawal-actions";
import {
  listWithdrawals,
  type QueueState,
  type WithdrawalQueueItem,
} from "@/lib/peragus/operator-console";
import { queueStateLabels } from "@/lib/peragus/operator-labels";

export const Route = createFileRoute("/operador/saques")({ component: WithdrawalPage });
function WithdrawalPage() {
  return (
    <OperatorShell
      title="Fila de saques"
      description="Aprovação e envio exigem MFA recente; cada intenção usa uma chave de idempotência nova."
    >
      {(context) => <WithdrawalConsole {...context} />}
    </OperatorShell>
  );
}

type Panel = { kind: "approve" | "execute" | "details"; item: WithdrawalQueueItem };
const filters: (QueueState | "all")[] = [
  "all",
  "pending_approval",
  "approved",
  "reserved",
  "uncertain",
  "processing",
  "completed",
  "needs_review",
];

/** sessionStorage key of a money intent left unresolved when the operator left this screen. */
const LEFT_KEY = "peragus.operator.withdrawal-intent-left";
function readLeftIntent(): QueueIntent | null {
  try {
    const raw = sessionStorage.getItem(LEFT_KEY);
    sessionStorage.removeItem(LEFT_KEY);
    const value = raw ? (JSON.parse(raw) as QueueIntent) : null;
    return value && /^[0-9a-f-]{36}$/i.test(value.itemId) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Withdrawal queue: amounts and a short wallet prefix only; Aprovar, Executar, Detalhes.
 * The money action lives here (not in the dialog): while it is in flight or unresolved
 * (MFA retry, unknown outcome) the rows, the filter and the dialog's Cancelar are locked, so
 * the pending request_id and its "resultado incerto" notice are never abandoned. The request
 * is never aborted; leaving the screen records it and the next visit shows the notice.
 */
export function WithdrawalConsole(context: OperatorContext) {
  const [filter, setFilter] = useState<QueueState | "all">("all");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [notice, setNotice] = useState("");
  const [left] = useState(readLeftIntent);
  const action = useFreshMfaAction(context.verifyMfa);
  const intent = useRef<QueueIntent | null>(null);
  const locked = useRef(false);
  locked.current = action.locked;
  const read = useOperatorRead(
    context.token,
    (token, signal) => listWithdrawals(token, filter, signal),
    filter,
  );
  useEffect(() => {
    if (!action.locked) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [action.locked]);
  useEffect(
    () => () => {
      if (!locked.current || !intent.current) return;
      try {
        sessionStorage.setItem(LEFT_KEY, JSON.stringify(intent.current));
      } catch {
        // Storage unavailable: the beforeunload warning still applied.
      }
    },
    [],
  );
  const done = (message: string) => {
    intent.current = null;
    setNotice(message);
    setPanel(null);
    read.reload();
  };
  const open = (kind: Panel["kind"], item: WithdrawalQueueItem) => {
    if (action.locked) return;
    setNotice("");
    setPanel({ kind, item });
  };
  return (
    <>
      {left && (
        <CustomerNotice kind="warning">
          Uma {left.kind === "execute" ? "execução de envio" : "aprovação"} do saque{" "}
          {left.itemId.slice(0, 8)} ficou sem resultado confirmado quando você saiu da tela.
          Consulte o saque (Detalhes) antes de qualquer nova ação; não inicie outra intenção.
        </CustomerNotice>
      )}
      {notice && <CustomerNotice>{notice}</CustomerNotice>}
      <FreshMfaForm action={action} token={context.token} />
      <OperatorMfaGate reads={[read]} context={context} />
      <CustomerPanel title="Saques">
        <div className="customer-row">
          <label className="customer-field">
            Situação
            <select
              value={filter}
              disabled={action.locked}
              onChange={(event) => {
                setFilter(event.target.value as QueueState | "all");
                setPanel(null);
              }}
            >
              {filters.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "Todas" : queueStateLabels[value]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="customer-button-secondary"
            disabled={read.loading || action.locked}
            onClick={() => read.reload()}
          >
            Atualizar fila
          </button>
        </div>
        <OperatorRead read={read} loadingText="Consultando fila protegida…">
          {(items) =>
            items.length === 0 ? (
              <p>Nenhum saque nesta situação.</p>
            ) : (
              items.map((item) => (
                <div className="customer-row" key={item.id}>
                  <span>
                    <strong>{queueStateLabels[item.state] ?? item.state}</strong>
                    <br />
                    {item.source.amount} USDT · carteira{" "}
                    {walletPrefix(item.destination.wallet_address)} ·{" "}
                    {new Date(item.created_at).toLocaleString("pt-BR")}
                    {item.refund_request && <> · estorno: {item.refund_request.state}</>}
                    <small className="operator-code">
                      {item.state} · saque {item.id.slice(0, 8)} · operação{" "}
                      {item.purchase_intent_id.slice(0, 8)}
                    </small>
                  </span>
                  <span>
                    {item.state === "pending_approval" && (
                      <button
                        type="button"
                        className="customer-button-secondary"
                        disabled={action.locked}
                        onClick={() => open("approve", item)}
                      >
                        Aprovar
                      </button>
                    )}
                    {item.state === "approved" && (
                      <button
                        type="button"
                        className="customer-button-secondary"
                        disabled={action.locked}
                        onClick={() => open("execute", item)}
                      >
                        Executar
                      </button>
                    )}
                    {!["pending_approval", "approved"].includes(item.state) && (
                      <button
                        type="button"
                        className="customer-button-secondary"
                        disabled={action.locked}
                        onClick={() => open("details", item)}
                      >
                        Detalhes
                      </button>
                    )}
                    {!action.locked &&
                      ["pending_approval", "needs_review"].includes(item.state) && (
                        <Link
                          className="customer-link"
                          to="/operador/estornos"
                          search={{ operacao: item.purchase_intent_id }}
                        >
                          Decidir estorno
                        </Link>
                      )}
                  </span>
                </div>
              ))
            )
          }
        </OperatorRead>
      </CustomerPanel>
      {panel?.kind === "approve" && (
        <ApproveDialog
          key={panel.item.id}
          item={panel.item}
          context={context}
          action={action}
          onStart={() => (intent.current = { kind: "approve", itemId: panel.item.id })}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel?.kind === "execute" && (
        <ExecuteDialog
          key={panel.item.id}
          item={panel.item}
          context={context}
          action={action}
          onStart={() => (intent.current = { kind: "execute", itemId: panel.item.id })}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel?.kind === "details" && (
        <ExecutionDetails key={panel.item.id} item={panel.item} context={context} />
      )}
    </>
  );
}
