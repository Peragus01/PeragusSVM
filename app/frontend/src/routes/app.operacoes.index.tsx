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
function CustomerOperations() {
  const { data, state, error, more, retry } = useOperations(20);
  return (
    <>
      <SectionTitle
        eyebrow="TRANSPARÊNCIA / HISTÓRICO"
        title="Operações"
        description="Histórico exclusivo da sua conta, consultado pelo servidor com autenticação."
      />
      <CustomerNotice>
        Os registros exibidos pertencem ao ambiente de testes. Conclusão do provedor não significa
        entrega on-chain confirmada.
      </CustomerNotice>
      <CustomerPanel title="Histórico de operações">
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
            Buscando registros autenticados…
          </p>
        )}
        {state !== "error" && data?.data.length === 0 && (
          <CustomerEmpty
            title="Nenhum registro disponível"
            description="Ainda não existem operações associadas à sua identidade."
          />
        )}
        {data && data.data.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="customer-table">
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
                {data.data.map((op) => (
                  <tr key={op.id}>
                    <td>{displayDate(op.created_at)}</td>
                    <td>{formatAmount(op.source.amount, "BRL")}</td>
                    <td>
                      {formatAmount(op.estimated_target.amount, "USDT")}{" "}
                      <span className="customer-muted">indicativo</span>
                    </td>
                    <td>
                      <span className={"customer-chip " + statusStyle(op)}>
                        {operationLabel(op)}
                      </span>
                    </td>
                    <td>
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
