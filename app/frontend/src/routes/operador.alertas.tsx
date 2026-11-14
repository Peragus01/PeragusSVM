import { createFileRoute, Link } from "@tanstack/react-router";
import { CustomerPanel } from "@/components/peragus/customer-ui";
import { useOperatorRead } from "@/components/peragus/operator-actions";
import {
  OperatorMfaGate,
  OperatorRead,
  OperatorShell,
  type OperatorContext,
} from "@/components/peragus/operator-shell";
import { listAlerts, listNotifications, type OperatorAlert } from "@/lib/peragus/operator-console";
import {
  alertKindLabels,
  notificationKindLabels,
  notificationStatusLabels,
} from "@/lib/peragus/operator-labels";

export const Route = createFileRoute("/operador/alertas")({ component: AlertsPage });
function AlertsPage() {
  return (
    <OperatorShell
      title="Alertas"
      description="Derivados de dados gravados; nenhum alerta chama o provedor nem altera operações."
    >
      {(context) => <AlertsConsole {...context} />}
    </OperatorShell>
  );
}

/** Where the operator acts on an alert. */
function AlertAction({ alert }: { alert: OperatorAlert }) {
  if (
    alert.refund_request_id ||
    alert.kind === "pix_open_after_close" ||
    alert.kind === "operation_review"
  )
    return (
      <Link
        className="customer-link"
        to="/operador/estornos"
        search={alert.refund_request_id ? {} : { operacao: alert.purchase_intent_id }}
      >
        Abrir estornos
      </Link>
    );
  if (alert.withdrawal_request_id)
    return (
      <Link className="customer-link" to="/operador/saques">
        Abrir saques
      </Link>
    );
  return null;
}

export function AlertList({ alerts }: { alerts: OperatorAlert[] }) {
  if (!alerts.length) return <p>Nenhum alerta aberto.</p>;
  return (
    <>
      {alerts.map((alert) => (
        <div className="customer-row" key={alert.id}>
          <span>
            <strong>{alertKindLabels[alert.kind] ?? alert.kind}</strong>
            <br />
            {alert.severity === "high" ? "Alta" : "Média"} · desde{" "}
            {new Date(alert.first_recorded_at).toLocaleString("pt-BR")}
            <small className="operator-code">
              {alert.kind} · operação {alert.purchase_intent_id.slice(0, 8)}
            </small>
          </span>
          <AlertAction alert={alert} />
        </div>
      ))}
    </>
  );
}

/** GET /v1/admin/operational-alerts + GET /v1/admin/operator-notifications (uncertain/failed). */
export function AlertsConsole(context: OperatorContext) {
  const alerts = useOperatorRead(context.token, (token, signal) => listAlerts(token, {}, signal));
  const notifications = useOperatorRead(context.token, (token, signal) =>
    listNotifications(token, undefined, signal),
  );
  return (
    <>
      <OperatorMfaGate reads={[alerts, notifications]} context={context} />
      <CustomerPanel title="Alertas operacionais">
        <button
          type="button"
          className="customer-button-secondary"
          disabled={alerts.loading}
          onClick={() => {
            alerts.reload();
            notifications.reload();
          }}
        >
          Atualizar
        </button>
        <OperatorRead read={alerts} loadingText="Consultando alertas…">
          {(rows) => <AlertList alerts={rows} />}
        </OperatorRead>
        <p className="customer-muted">
          Operações paradas (envio há mais de 30 min, enviada sem verificação, Pix vencido, revisão
          há mais de 4/12 h, estorno há mais de 12/20 h) chegam por e-mail como “Operação parada” e
          aparecem abaixo se o e-mail não for confirmado.
        </p>
      </CustomerPanel>
      <CustomerPanel title="Notificações por e-mail não confirmadas">
        <OperatorRead read={notifications} loadingText="Consultando notificações…">
          {(rows) =>
            rows.length === 0 ? (
              <p>Nenhuma notificação incerta ou com falha.</p>
            ) : (
              rows.map((row) => (
                <div className="customer-row" key={row.id}>
                  <span>
                    <strong>{notificationKindLabels[row.kind] ?? row.kind}</strong>
                    <br />
                    {notificationStatusLabels[row.status]} · destinatário:{" "}
                    {row.recipient_role === "trusted" ? "pessoa de confiança" : "operador"} ·{" "}
                    {new Date(row.updated_at).toLocaleString("pt-BR")}
                    <small className="operator-code">
                      {row.kind} · {row.status}
                      {row.last_error ? ` · ${row.last_error}` : ""}
                      {row.purchase_id ? ` · operação ${row.purchase_id.slice(0, 8)}` : ""}
                    </small>
                  </span>
                </div>
              ))
            )
          }
        </OperatorRead>
      </CustomerPanel>
    </>
  );
}
