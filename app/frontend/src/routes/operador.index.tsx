import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CustomerPanel } from "@/components/peragus/customer-ui";
import { useOperatorRead } from "@/components/peragus/operator-actions";
import {
  OperatorMfaGate,
  OperatorRead,
  OperatorShell,
  type OperatorContext,
} from "@/components/peragus/operator-shell";
import { AlertList } from "@/routes/operador.alertas";
import {
  getDailyReview,
  getRuntimeControls,
  listAlerts,
  listWithdrawals,
} from "@/lib/peragus/operator-console";
import { listRefunds, refundLabels, type RefundState } from "@/lib/peragus/refunds";
import {
  addDays,
  controlLabels,
  queueStateLabels,
  saoPauloDay,
} from "@/lib/peragus/operator-labels";

export const Route = createFileRoute("/operador/")({ component: OperatorDashboardPage });
function OperatorDashboardPage() {
  return (
    <OperatorShell title="Console do operador">
      {(context) => <OperatorDashboard {...context} />}
    </OperatorShell>
  );
}

const count = <T extends string>(values: T[]) =>
  values.reduce<Partial<Record<T, number>>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});

/** Switch states, the daily review, open operations by status and the top high alerts. */
export function OperatorDashboard({ now, ...context }: OperatorContext & { now?: Date }) {
  const [clock] = useState(() => now ?? new Date());
  const today = saoPauloDay(clock),
    yesterday = addDays(today, -1);
  const controls = useOperatorRead(context.token, (token, signal) =>
    getRuntimeControls(token, signal),
  );
  const queue = useOperatorRead(context.token, (token, signal) =>
    listWithdrawals(token, "all", signal),
  );
  const refunds = useOperatorRead(context.token, (token, signal) =>
    listRefunds(token, undefined, signal),
  );
  const alerts = useOperatorRead(context.token, (token, signal) =>
    listAlerts(token, { severity: "high", limit: 5 }, signal),
  );
  const review = useOperatorRead(context.token, (token, signal) =>
    getDailyReview(token, yesterday, signal),
  );
  return (
    <>
      <OperatorMfaGate reads={[controls, queue, refunds, alerts, review]} context={context} />
      <CustomerPanel title="Chaves operacionais">
        <OperatorRead read={controls} loadingText="Consultando chaves…">
          {(rows) => (
            <ul className="operator-counts">
              {rows.map((row) => (
                <li key={row.key}>
                  {controlLabels[row.key]}: {row.enabled ? "ligada" : "desligada"}
                </li>
              ))}
            </ul>
          )}
        </OperatorRead>
        <Link className="customer-link" to="/operador/controles">
          Alterar chaves
        </Link>
      </CustomerPanel>
      <CustomerPanel title="Revisão diária">
        <OperatorRead read={review} loadingText="Consultando a revisão de ontem…">
          {(status) => (
            <p>
              <strong>
                {status.reviewed
                  ? `Ontem (${status.day}): revisada em ${new Date(status.reviewed_at ?? "").toLocaleString("pt-BR")}.`
                  : status.has_activity
                    ? `Ontem (${status.day}): revisão pendente com atividade — novas operações ficam bloqueadas até o registro.`
                    : `Ontem (${status.day}): sem atividade; a revisão não é exigida.`}
              </strong>
            </p>
          )}
        </OperatorRead>
        <p className="customer-muted">
          Hoje ({today}, São Paulo) só pode ser revisado depois de terminar.
        </p>
        <Link className="customer-link" to="/operador/revisao-diaria">
          Registrar a revisão de ontem
        </Link>
      </CustomerPanel>
      <CustomerPanel title="Operações abertas por situação">
        <OperatorRead read={queue} loadingText="Consultando saques…">
          {(items) => {
            const open = count(
              items.filter((item) => item.state !== "completed").map((i) => i.state),
            );
            const entries = Object.entries(open) as [string, number][];
            return entries.length ? (
              <ul className="operator-counts">
                {entries.map(([state, total]) => (
                  <li key={state}>{`${queueStateLabels[state] ?? state}: ${total}`}</li>
                ))}
              </ul>
            ) : (
              <p>Nenhum saque aberto nos 50 mais recentes.</p>
            );
          }}
        </OperatorRead>
        <OperatorRead read={refunds} loadingText="Consultando estornos…">
          {(page) => {
            const open = count(
              page.data
                .map((row) => row.state)
                .filter((state): state is RefundState =>
                  ["pending_review", "approved"].includes(state),
                ),
            );
            const entries = Object.entries(open) as [RefundState, number][];
            return entries.length ? (
              <ul className="operator-counts">
                {entries.map(([state, total]) => (
                  <li key={state}>{`Estorno ${refundLabels[state].toLowerCase()}: ${total}`}</li>
                ))}
              </ul>
            ) : (
              <p>Nenhum estorno aberto nos 20 mais recentes.</p>
            );
          }}
        </OperatorRead>
        <Link className="customer-link" to="/operador/saques">
          Abrir fila de saques
        </Link>
      </CustomerPanel>
      <CustomerPanel title="Alertas de alta gravidade">
        <OperatorRead read={alerts} loadingText="Consultando alertas…">
          {(rows) => <AlertList alerts={rows} />}
        </OperatorRead>
        <Link className="customer-link" to="/operador/alertas">
          Todos os alertas e notificações
        </Link>
      </CustomerPanel>
    </>
  );
}
