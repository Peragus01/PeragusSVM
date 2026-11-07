import { AutomaticPurchaseForm } from "@/components/peragus/automatic-purchase";
import { OnboardingEvidence } from "@/components/peragus/onboarding-evidence";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck, ArrowRight } from "lucide-react";
import { CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
export { AutomaticPurchaseForm as PurchaseForm } from "@/components/peragus/automatic-purchase";
export const Route = createFileRoute("/app/comprar-usdt")({ component: PurchasePage });
function PurchasePage() {
  const { identity, accessToken } = useCustomerSession();
  return (
    <>
      <SectionTitle
        eyebrow="REAIS → USDT"
        title="Comprar USDT"
        description="Uma compra simples. Cada etapa no seu tempo."
      />
      <div className="premium-purchase-layout">
        {identity?.customer && accessToken && (
          <AutomaticPurchaseForm
            key={identity.customer.id}
            customerId={identity.customer.id}
            token={accessToken}
          />
        )}
        {!identity?.customer && (
          <CustomerPanel title="Complete seu cadastro">
            <CustomerNotice>
              Seu perfil ainda não está disponível para consultar uma cotação.
            </CustomerNotice>
            <Link to="/app/minha-conta" className="customer-link">
              Ver minha conta
            </Link>
          </CustomerPanel>
        )}
        <aside className="premium-purchase-aside">
          <div className="premium-side-intro">
            <ShieldCheck size={23} />
            <h2>Clareza antes de continuar.</h2>
            <p>
              Confira a estimativa, os custos disponíveis e o endereço vinculado à sua conta. Você
              acompanha os próximos estados pelo histórico.
            </p>
          </div>
          <CustomerPanel title="Sua conta">
            <div className="customer-row">
              <span>E-mail</span>
              <b>{identity?.user.email ?? "—"}</b>
            </div>
            <details>
              <summary>Verificações de identidade</summary>
              <OnboardingEvidence />
            </details>
            <Link to="/app/minha-conta" className="customer-link">
              Gerenciar minha conta <ArrowRight size={15} />
            </Link>
          </CustomerPanel>
          <div className="premium-help">
            <h3>Reais, Pix e Solana</h3>
            <p>
              A cotação é uma estimativa. O pagamento e a entrega são etapas separadas e dependem de
              confirmação.
            </p>
            <p className="customer-muted">
              Neste ambiente, qualquer Pix disponível é de teste. A entrega real de USDT continua
              desabilitada.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
