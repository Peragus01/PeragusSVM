import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CustomerEmpty,
  CustomerNotice,
  CustomerPanel,
  SectionTitle,
} from "@/components/peragus/customer-ui";
import {
  displayDate,
  operationLabel,
  useOperations,
} from "@/components/peragus/customer-operations";
export const Route = createFileRoute("/app/auditoria")({ component: CustomerAudit });
function CustomerAudit() {
  const { data, state, error, retry, more } = useOperations(20);
  return (
    <>
      <SectionTitle
        eyebrow="HISTÓRICO / SUPORTE"
        title="Detalhes da transação"
        description="Consulte os registros das suas transações e informações de suporte."
      />
      <CustomerNotice kind="warning">
        Esta visão apresenta exclusivamente metadados das operações do usuário autenticado. Não
        apresenta auditoria interna, documentos de outros clientes nem comprovação Solana
        inexistente.
      </CustomerNotice>
      <CustomerPanel title="Registros observáveis">
        {state === "loading" && !data && (
          <p role="status" className="customer-muted">
            Consultando seus registros…
          </p>
        )}
        {state === "error" && (
          <>
            <CustomerNotice kind="danger">{error}</CustomerNotice>
            <button className="customer-button-secondary" type="button" onClick={retry}>
              Tentar novamente
            </button>
          </>
        )}
        {state !== "error" && data?.data.length === 0 && (
          <CustomerEmpty
            title="Nenhum registro disponível"
            description="Eventos de operações aparecerão aqui quando existirem registros associados à conta."
          />
        )}
        {data?.data.map((op) => (
          <div key={op.id} className="customer-row">
            <div>
              <b>{operationLabel(op)}</b>
              <div className="customer-muted">
                {displayDate(op.created_at)} · Ambiente {op.environment}
              </div>
              <div className="customer-muted">
                Confirmação on-chain:{" "}
                {op.onchain_delivery_verified ? "verificada" : "não verificada"}
              </div>
            </div>
            <Link className="customer-link" to="/app/operacoes/$id" params={{ id: op.id }}>
              Ver detalhes
            </Link>
          </div>
        ))}
        {state === "ready" && data?.meta.has_more && (
          <button
            className="customer-button-secondary"
            style={{ marginTop: 20 }}
            type="button"
            onClick={more}
          >
            Carregar mais
          </button>
        )}
      </CustomerPanel>
    </>
  );
}
