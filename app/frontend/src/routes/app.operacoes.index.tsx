import { useState } from "react";
import { refundLabels } from "@/lib/peragus/refunds";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CustomerEmpty,
  CustomerNotice,
  CustomerPanel,
  SectionTitle,
} from "@/components/peragus/customer-ui";
import {
  useOperations,
  displayDate,
  formatAmount,
  operationLabel,
  statusStyle,
} from "@/components/peragus/customer-operations";
export const Route = createFileRoute("/app/operacoes/")({ component: CustomerOperations });
export function CustomerOperations() {
  const { data, state, error, more, retry } = useOperations(20);
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [stage, setStage] = useState("");
  const invalidPeriod = Boolean(from && until && from > until);
  const visible = (data?.data ?? []).filter((op) => {
    const d = new Date(op.created_at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return (
      !invalidPeriod &&
      (!from || day >= from) &&
      (!until || day <= until) &&
      (!stage || op.stage === stage)
    );
  });
  return (
    <>
      <SectionTitle
        eyebrow="SUAS TRANSAÇÕES"
        title="Histórico de compras"
        description="Acompanhe valores, pagamentos e a entrega na sua carteira."
      />
      <CustomerNotice>
        Ambiente de testes · sem dinheiro real. Um registro ou processamento finalizado não
        significa USDT entregue.
      </CustomerNotice>
      <CustomerPanel
        title="Suas compras"
        action={
          <Link to="/app/comprar-usdt" className="customer-link">
            Comprar USDT →
          </Link>
        }
      >
        <div className="customer-history-filters">
          <label className="customer-field">
            De
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="customer-field">
            Até
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <label className="customer-field">
            Etapa
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">Todas as etapas</option>
              <option value="purchase_recorded">Registro de teste</option>
              <option value="pix">Pix / conversão</option>
              <option value="withdrawal">Entrega</option>
            </select>
          </label>
          {(from || until || stage) && (
            <button
              type="button"
              className="customer-button-secondary"
              onClick={() => {
                setFrom("");
                setUntil("");
                setStage("");
              }}
            >
              Limpar filtros
            </button>
          )}
          <p>
            Os filtros se aplicam aos registros carregados. Use “Carregar mais” para consultar
            registros anteriores.
          </p>
        </div>
        {invalidPeriod && (
          <CustomerNotice kind="warning">
            A data inicial deve ser anterior ou igual à data final.
          </CustomerNotice>
        )}
        {state === "ready" &&
          Boolean(data?.data.length) &&
          visible.length === 0 &&
          !invalidPeriod && (
            <CustomerEmpty
              title="Nenhuma operação neste filtro"
              description="Ajuste as datas ou a etapa. Você também pode carregar mais registros, quando disponíveis."
            />
          )}
        {state === "error" && (
          <>
            <CustomerNotice kind="danger">{error}</CustomerNotice>
            <button type="button" className="customer-button-secondary" onClick={retry}>
              Tentar novamente
            </button>
          </>
        )}
        {state === "loading" && !data && (
          <p role="status" className="customer-muted">
            Carregando histórico…
          </p>
        )}
        {state !== "error" && data?.data.length === 0 && (
          <CustomerEmpty
            title="Nenhum registro disponível"
            description="Suas compras e registros de teste aparecerão aqui."
          />
        )}
        {data && visible.length > 0 && (
          <div
            className="customer-table-scroll"
            role="region"
            aria-label="Tabela de operações"
            tabIndex={0}
          >
            <table className="customer-table premium-history-table">
              <caption className="sr-only">Operações da sua conta no ambiente de testes</caption>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Compra</th>
                  <th>Estimativa USDT</th>
                  <th>Status</th>
                  <th>Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((op) => (
                  <tr key={op.id}>
                    <td data-label="Data">{displayDate(op.created_at)}</td>
                    <td data-label="Valor em reais">{formatAmount(op.source.amount, "BRL")}</td>
                    <td data-label="USDT estimado">
                      {formatAmount(op.estimated_target.amount, "USDT")}{" "}
                      <span className="customer-muted">indicativo</span>
                    </td>
                    <td data-label="Status">
                      <span className={"customer-chip " + statusStyle(op)}>
                        {operationLabel(op)}
                      </span>
                      {op.refund_request && (
                        <p className="customer-muted">
                          Estorno: {refundLabels[op.refund_request.state]}
                        </p>
                      )}
                    </td>
                    <td data-label="Transação">
                      <details className="premium-history-reference">
                        <summary>Referências</summary>
                        <span className="premium-address">
                          ID: {op.id}
                          <br />
                          Carteira: {op.destination?.wallet_address ?? "Não informada"}
                        </span>
                      </details>
                      <Link
                        className="customer-link"
                        to="/app/operacoes/$id"
                        params={{ id: op.id }}
                      >
                        Abrir
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state === "loading" && data && (
          <p className="customer-muted" role="status">
            Buscando mais registros…
          </p>
        )}
        {state === "ready" && data?.meta.has_more && (
          <button
            type="button"
            className="customer-button-secondary"
            style={{ marginTop: 20 }}
            onClick={more}
          >
            Carregar mais
          </button>
        )}
      </CustomerPanel>
    </>
  );
}
