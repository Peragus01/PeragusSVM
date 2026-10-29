import { OnboardingEvidence } from "@/components/peragus/onboarding-evidence";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
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
        eyebrow="SUA CENTRAL FINANCEIRA"
        title={"Olá, " + name + "."}
        description="Sua conta e suas últimas operações, com clareza em cada etapa."
        action={
          <Link to="/app/comprar-usdt" className="customer-button">
            Comprar USDT <ArrowUpRight size={15} />
          </Link>
        }
      />
      <CustomerNotice kind="warning">
        Você está no piloto sandbox. Os registros são de teste e não representam movimentações de
        dinheiro real.
      </CustomerNotice>
      <div className="customer-grid">
        <div className="customer-panel customer-metric">
          <span>Perfil cadastral local</span>
          <strong>{identity?.customer?.verification_status ?? "Sem perfil"}</strong>
          <small>Separado das verificações de identidade</small>
        </div>
        <div className="customer-panel customer-metric">
          <span>Operações financeiras</span>
          <strong>
            {identity?.customer?.operations_enabled ? "Consultar condições" : "Indisponíveis"}
          </strong>
          <small>Disponibilidade sujeita às condições da conta</small>
        </div>
        <div className="customer-panel customer-metric">
          <span>Operações recentes</span>
          <strong>{state === "ready" ? String(data?.data.length ?? 0) : "—"}</strong>
          <small>Nesta consulta · veja mais no histórico</small>
        </div>
      </div>
      <div className="customer-grid-two">
        <CustomerPanel
          title="Últimas operações"
          action={
            <Link to="/app/operacoes" className="customer-link">
              Ver histórico <ArrowUpRight size={14} />
            </Link>
          }
        >
          {state === "loading" ? (
            <p role="status" className="customer-muted">
              Carregando operações…
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
              title="Nenhuma operação registrada"
              description="Seus registros autenticados aparecerão aqui quando estiverem disponíveis."
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
              [
                "2",
                "Carteira",
                "Confira a carteira conectada e o que ela representa no ambiente de testes.",
              ],
              ["3", "Compra", "Consulte uma cotação indicativa e registre sua intenção em reais."],
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
      <CustomerPanel title="Cadastro e verificação de identidade">
        <OnboardingEvidence />
      </CustomerPanel>
    </>
  );
}
