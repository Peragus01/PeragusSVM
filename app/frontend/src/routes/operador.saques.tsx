import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CustomerNotice, CustomerPanel } from "@/components/peragus/customer-ui";
import { useOperatorRead } from "@/components/peragus/operator-actions";
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

/** Withdrawal queue: amounts and a short wallet prefix only; Aprovar, Executar, Detalhes. */
export function WithdrawalConsole(context: OperatorContext) {
  const [filter, setFilter] = useState<QueueState | "all">("all");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [notice, setNotice] = useState("");
  const read = useOperatorRead(
    context.token,
    (token, signal) => listWithdrawals(token, filter, signal),
    filter,
  );
  const done = (message: string) => {
    setNotice(message);
    setPanel(null);
    read.reload();
  };
  return (
    <>
      {notice && <CustomerNotice>{notice}</CustomerNotice>}
      <OperatorMfaGate reads={[read]} context={context} />
      <CustomerPanel title="Saques">
        <div className="customer-row">
          <label className="customer-field">
            Situação
            <select
              value={filter}
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
            disabled={read.loading}
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
                        onClick={() => setPanel({ kind: "approve", item })}
                      >
                        Aprovar
                      </button>
                    )}
                    {item.state === "approved" && (
                      <button
                        type="button"
                        className="customer-button-secondary"
                        onClick={() => setPanel({ kind: "execute", item })}
                      >
                        Executar
                      </button>
                    )}
                    {!["pending_approval", "approved"].includes(item.state) && (
                      <button
                        type="button"
                        className="customer-button-secondary"
                        onClick={() => setPanel({ kind: "details", item })}
                      >
                        Detalhes
                      </button>
                    )}
                    {["pending_approval", "needs_review"].includes(item.state) && (
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
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel?.kind === "execute" && (
        <ExecuteDialog
          key={panel.item.id}
          item={panel.item}
          context={context}
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
