import { createFileRoute } from "@tanstack/react-router";
import { CustomerDocuments } from "@/components/peragus/customer-documents";
import { SectionTitle } from "@/components/peragus/customer-ui";

export const Route = createFileRoute("/app/documentos")({ component: DocumentsPage });
export function DocumentsPage() {
  return (
    <>
      <SectionTitle
        eyebrow="CADASTRO E VERIFICAÇÃO"
        title="Verificação de identidade"
        description="Seu cadastro, seus documentos e o acompanhamento da sua verificação em um só lugar."
      />
      <CustomerDocuments />
    </>
  );
}
