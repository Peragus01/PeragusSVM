import { OnboardingEvidence } from "@/components/peragus/onboarding-evidence";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Wallet, ArrowRight, ArrowUpRight } from "lucide-react";
import {
  CustomerEmpty,
  CustomerNotice,
  CustomerPanel,
  SectionTitle,
} from "@/components/peragus/customer-ui";
import {
  useOperations,
  formatAmount,
  operationLabel,
  statusStyle,
  displayDate,
} from "@/components/peragus/customer-operations";
import { useCustomerSession } from "@/lib/peragus/customer-session";
export const Route = createFileRoute("/app/")({ component: CustomerDashboard });
function CustomerDashboard() {
  const { identity } = useCustomerSession();
  const { data, state, error, retry } = useOperations(5);
  const name = identity?.customer?.display_name || identity?.user.email.split("@")[0] || "cliente";
  return (
    <>
      <SectionTitle
        eyebrow="MINHA PERAGUS"
        title={"Olá, " + name + "."}
        description="Suas compras, sua carteira e o próximo passo, em um só lugar."
        action={
          <Link to="/app/comprar-usdt" className="customer-button">
            Comprar USDT <ArrowUpRight size={15} />
          </Link>
        }
      />
      <section className="premium-dashboard-hero">
        <div>
          <span className="customer-eyebrow">DO SEU JEITO. NA SUA CARTEIRA.</span>
          <h2>
            Reais aqui.
            <br />
            <em>USDT para ir além.</em>
          </h2>
          <p>Consulte sua cotação, confira os detalhes e acompanhe cada confirmação.</p>
          <Link to="/app/comprar-usdt" className="customer-button">
            Comprar USDT <ArrowRight size={18} />
          </Link>
          <small>
            Ambiente de testes · sem dinheiro real. Sem movimentação ou entrega de USDT reais.
          </small>
        </div>
        <div className="premium-dashboard-assets" aria-hidden="true">
          <span className="premium-orbit" />
          <span className="premium-hero-coin brl-icon">R$</span>
          <ArrowRight size={28} />
          <span className="premium-hero-coin usdt-icon">₮</span>
          <span className="premium-orbit second" />
        </div>
      </section>
      <div className="premium-quick-grid">
        <Link to="/app/carteira" className="premium-quick-link">
          <Wallet size={23} />
          <div>
            <b>Minha carteira</b>
            <p>Confira sua conexão e a rede disponível.</p>
          </div>
          <ArrowUpRight size={20} />
        </Link>
        <Link to="/app/minha-conta" className="premium-quick-link">
          <span className="premium-account-dot" />
          <div>
            <b>Minha conta</b>
            <p>Cadastro, acesso e verificações de identidade.</p>
          </div>
          <ArrowUpRight size={20} />
        </Link>
      </div>
      <div className="customer-grid-two">
        <CustomerPanel
          title="Últimas compras"
          action={
            <Link to="/app/operacoes" className="customer-link">
              Ver histórico <ArrowUpRight size={14} />
            </Link>
          }
        >
          {state === "loading" ? (
            <p role="status" className="customer-muted">
              Carregando histórico…
            </p>
          ) : state === "error" ? (
            <>
              <CustomerNotice kind="danger">{error}</CustomerNotice>
              <button type="button" className="customer-button-secondary" onClick={retry}>
                Tentar novamente
              </button>
            </>
          ) : !data?.data.length ? (
            <CustomerEmpty
              title="Seu histórico começa aqui"
              description="Suas compras e registros de teste aparecerão aqui. Consulte uma cotação para começar."
            />
          ) : (
            data.data.map((op) => (
              <div className="customer-row" key={op.id}>
                <div>
                  <b>{formatAmount(op.source.amount, "BRL")}</b>
                  <div className="customer-muted">
                    {displayDate(op.created_at)} · {op.environment === "test" ? "Teste" : "—"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span className={"customer-chip " + statusStyle(op)}>{operationLabel(op)}</span>
                  <div style={{ marginTop: 6 }}>
                    <Link className="customer-link" to="/app/operacoes/$id" params={{ id: op.id }}>
                      Detalhes
                    </Link>
                  </div>
                </div>
              </div>
            ))
          )}
        </CustomerPanel>
        <CustomerPanel title="Próximos passos">
          <div className="customer-steps">
            {[
              ["1", "Identidade", "Confira o status cadastral e de verificação em Minha conta."],
              ["2", "Carteira", "Confira seu endereço e a rede antes de qualquer transferência."],
              ["3", "Cotação", "Informe o valor em reais e revise a estimativa de USDT."],
            ].map(([n, t, d]) => (
              <div className="customer-step" key={n}>
                <span className="customer-step-count">{n}</span>
                <div>
                  <h3>{t}</h3>
                  <p>{d}</p>
                </div>
              </div>
            ))}
          </div>
          <Link to="/app/minha-conta" className="customer-link">
            Ver minha conta <ArrowUpRight size={14} />
          </Link>
        </CustomerPanel>
      </div>
      <details className="premium-account-details">
        <summary>Cadastro e verificação de identidade</summary>
        <OnboardingEvidence />
      </details>
    </>
  );
}
