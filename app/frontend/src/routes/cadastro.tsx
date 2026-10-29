import { createFileRoute, Link } from "@tanstack/react-router";
import { CustomerPublicLayout, CustomerNotice } from "@/components/peragus/customer-ui";
export const Route = createFileRoute("/cadastro")({ component: RegistrationPage });
function RegistrationPage() {
  return (
    <CustomerPublicLayout>
      <div className="customer-auth-card">
        <span className="customer-eyebrow">PILOTO FECHADO</span>
        <h1>Cadastro por convite.</h1>
        <p>A Peragus está validando o produto com um grupo limitado de participantes.</p>
        <CustomerNotice kind="warning">
          A adesão pelo site ainda não está disponível. Se você recebeu um convite, aguarde as
          orientações da equipe Peragus. Nenhum cadastro será enviado por esta tela.
        </CustomerNotice>
        <ol className="customer-registration-steps">
          <li>
            <span>1</span>Receba um convite para participar do piloto.
          </li>
          <li>
            <span>2</span>Confirme seu acesso e complete seu cadastro quando a adesão estiver
            disponível.
          </li>
          <li>
            <span>3</span>Acompanhe as verificações de identidade pela sua conta.
          </li>
        </ol>
        <Link className="customer-button-secondary" to="/login">
          Voltar ao login
        </Link>
      </div>
    </CustomerPublicLayout>
  );
}
