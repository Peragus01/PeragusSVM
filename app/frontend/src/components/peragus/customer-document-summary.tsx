import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import {
  documentRequirements,
  listDocuments,
  type DocumentRecord,
  type DocumentRequirements,
} from "@/lib/peragus/documents";
import { CustomerPanel } from "./customer-ui";

export function CustomerDocumentSummary() {
  const { accessToken, identity } = useCustomerSession();
  return accessToken && identity?.customer ? (
    <DocumentSummary key={identity.user.id + ":" + identity.customer.id} token={accessToken} />
  ) : null;
}
function DocumentSummary({ token }: { token: string }) {
  const [value, setValue] = useState<{
    rows: DocumentRecord[];
    requirements: DocumentRequirements;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setFailed(false);
    void Promise.all([
      listDocuments(token, controller.signal),
      documentRequirements(token, controller.signal),
    ])
      .then(([rows, requirements]) => {
        if (!controller.signal.aborted) setValue({ rows, requirements });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [token]);
  return (
    <CustomerPanel title="Seus documentos">
      {failed ? (
        <p role="status">
          Não foi possível consultar o resumo. Abra a página de documentos para atualizar.
        </p>
      ) : !value ? (
        <p role="status">Consultando documentos…</p>
      ) : (
        <dl className="customer-document-summary">
          <div>
            <dt>Tipos solicitados</dt>
            <dd>{value.requirements.required_documents?.length ?? "Não informado"}</dd>
          </div>
          <div>
            <dt>Arquivos recebidos</dt>
            <dd>{value.rows.filter((row) => row.state === "received").length}</dd>
          </div>
          <div>
            <dt>Recebimento pendente</dt>
            <dd>
              {value.rows.filter((row) => !["received", "rejected"].includes(row.state)).length}
            </dd>
          </div>
          <div>
            <dt>Arquivos recusados</dt>
            <dd>{value.rows.filter((row) => row.state === "rejected").length}</dd>
          </div>
        </dl>
      )}
      <p className="customer-muted">
        Arquivos recebidos continuam sujeitos à análise de identidade.
      </p>
      <Link to="/app/documentos" className="customer-button-secondary">
        Enviar e acompanhar documentos →
      </Link>
    </CustomerPanel>
  );
}
