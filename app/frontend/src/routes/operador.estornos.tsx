import { OperatorResolutions } from "@/components/peragus/operator-resolutions";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CustomerPanel } from "@/components/peragus/customer-ui";
import { formatAmount } from "@/components/peragus/customer-operations";
import { useOperatorRead } from "@/components/peragus/operator-actions";
import {
  OperatorMfaGate,
  OperatorRead,
  OperatorShell,
  type OperatorContext,
} from "@/components/peragus/operator-shell";
import {
  OperationRefundDecision,
  RefundDecision,
  RefundDeadline,
} from "@/components/peragus/operator-refund-actions";
import { listRefunds, refundLabels, type OperatorRefund } from "@/lib/peragus/refunds";

const purchaseId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const Route = createFileRoute("/operador/estornos")({
  // ?operacao=<purchase id> pre-fills the operator refund decision (links from alerts/saques).
  validateSearch: (search: Record<string, unknown>): { operacao?: string } =>
    typeof search["operacao"] === "string" && purchaseId.test(search["operacao"])
      ? { operacao: search["operacao"] }
      : {},
  component: OperatorRefundPage,
});
function OperatorRefundPage() {
  const { operacao } = Route.useSearch();
  return (
    <OperatorShell
      title="Estornos"
      description="Decisões e devoluções são registros; nenhuma devolução é executada por esta tela."
    >
      {(context) => <OperatorRefunds {...context} linkedOperation={operacao ?? ""} />}
    </OperatorShell>
  );
}

function OperatorRefunds({
  linkedOperation,
  ...context
}: OperatorContext & { linkedOperation: string }) {
  const { token, verifyMfa } = context;
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<OperatorRefund | null>(null);
  const initialOperation = linkedOperation;
  const read = useOperatorRead(
    token,
    (accessToken, signal) => listRefunds(accessToken, cursor, signal),
    cursor ?? "",
  );
  const [saved, setSaved] = useState<Record<string, OperatorRefund>>({});
  const rows = (read.data?.data ?? []).map((row) => saved[row.id] ?? row);
  return (
    <>
      {/* As before Task 19b, this screen asks for the code only; enrollment is offered on the other operator screens. */}
      <OperatorMfaGate reads={[read]} context={{ token, verifyMfa }} />
      <OperationRefundDecision
        key={initialOperation}
        token={token}
        verifyMfa={verifyMfa}
        initialOperation={initialOperation}
        onSaved={() => read.reload()}
      />
      <OperatorResolutions
        key={`resolutions-${initialOperation}`}
        token={token}
        verifyMfa={verifyMfa}
        initialOperation={initialOperation}
        onSaved={() => read.reload()}
      />
      <CustomerPanel title="Pedidos de estorno">
        <OperatorRead read={read} loadingText="Consultando fila protegida…">
          {(page) => (
            <>
              {page.data.length === 0 && <p>Nenhum pedido nesta página.</p>}
              {rows.map((row) => (
                <div className="customer-row" key={row.id}>
                  <span style={{ overflowWrap: "anywhere" }}>
                    {row.id}
                    <br />
                    {refundLabels[row.state]} · {formatAmount(row.requested_amount.amount, "BRL")}
                    <br />
                    <RefundDeadline record={row} />
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
                  disabled={read.loading}
                  onClick={() => {
                    setSelected(null);
                    setSaved({});
                    if (cursor) setCursor(undefined);
                    else read.reload();
                  }}
                >
                  Atualizar fila
                </button>
                {page.nextCursor && (
                  <button
                    type="button"
                    className="customer-button-secondary"
                    disabled={read.loading}
                    onClick={() => {
                      setSelected(null);
                      setCursor(page.nextCursor ?? undefined);
                    }}
                  >
                    Próxima página
                  </button>
                )}
              </div>
            </>
          )}
        </OperatorRead>
      </CustomerPanel>
      {selected && (
        <RefundDecision
          key={selected.id}
          token={token}
          record={selected}
          verifyMfa={verifyMfa}
          onSaved={(value) => {
            setSelected(value);
            setSaved((current) => ({ ...current, [value.id]: value }));
          }}
        />
      )}
    </>
  );
}
