import { createFileRoute } from "@tanstack/react-router";
import { CustomerDocuments } from "@/components/peragus/customer-documents";
import { SectionTitle } from "@/components/peragus/customer-ui";

export const Route = createFileRoute("/app/documentos")({ component: DocumentsPage });
export function DocumentsPage() {
  return (
    <>
      <SectionTitle
        eyebrow="CADASTRO E VERIFICAÇÃO"
        title="Seus documentos"
        description="Consulte o que foi solicitado, envie seus arquivos e acompanhe o recebimento."
      />
      <CustomerDocuments />
    </>
  );
}
