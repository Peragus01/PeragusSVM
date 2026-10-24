import { createFileRoute, Link } from "@tanstack/react-router";
import { CustomerPublicLayout, CustomerNotice } from "@/components/peragus/customer-ui";
export const Route = createFileRoute("/cadastro")({ component: RegistrationPage });
function RegistrationPage() {
  return <CustomerPublicLayout><div className="customer-auth-card">
    <span className="customer-eyebrow">PILOTO FECHADO</span><h1>Cadastro por convite.</h1>
    <p>A Peragus está validando o produto com um grupo limitado de participantes.</p>
    <CustomerNotice kind="warning">O contrato de validação de convites ainda não está disponível no backend. O cadastro está temporariamente desabilitado: nenhum código será aceito somente pelo navegador.</CustomerNotice>
    <Link className="customer-button-secondary" to="/login">Voltar ao login</Link>
  </div></CustomerPublicLayout>;
}
