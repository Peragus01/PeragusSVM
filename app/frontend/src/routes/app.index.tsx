import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, History, Wallet } from "lucide-react";
import { CustomerOnboarding } from "@/components/peragus/customer-onboarding";
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
        eyebrow="SUA CONTA PERAGUS"
        title="Seu próximo passo, em um só lugar."
        description={"Olá, " + name + ". Prepare sua conta e acompanhe seus registros com tranquilidade."}
        action={
          <Link to="/app/comprar-usdt" className="customer-button-secondary">
            Conhecer a compra de USDT <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        }
      />
      <CustomerNotice>
        <strong>Piloto em preparação.</strong> Você pode conhecer a jornada de compra, mas ainda não
        pode gerar um Pix ou receber USDT por esta interface.
      </CustomerNotice>
      <CustomerOnboarding />

      <div className="customer-quick-grid" aria-label="Acessos rápidos">
        <Link to="/app/carteira" className="customer-quick-card">
          <span className="customer-quick-icon"><Wallet size={20} aria-hidden="true" /></span>
          <span>
            <strong>Minha carteira</strong>
            <small>Ver a conexão Solana Devnet</small>
          </span>
          <ArrowRight size={18} className="customer-quick-arrow" aria-hidden="true" />
        </Link>
        <Link to="/app/operacoes" className="customer-quick-card">
          <span className="customer-quick-icon"><History size={20} aria-hidden="true" /></span>
          <span>
            <strong>Minhas operações</strong>
            <small>Consultar histórico e estornos</small>
          </span>
          <ArrowRight size={18} className="customer-quick-arrow" aria-hidden="true" />
        </Link>
      </div>

      <CustomerPanel
        title="Atividade recente"
        action={
          <Link to="/app/operacoes" className="customer-link">
            Ver histórico completo <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        }
      >
        {state === "loading" ? (
          <p role="status" className="customer-muted">Carregando seus registros…</p>
        ) : state === "error" ? (
          <>
            <CustomerNotice kind="danger">{error}</CustomerNotice>
            <button type="button" className="customer-button-secondary" onClick={retry}>
              Tentar novamente
            </button>
          </>
        ) : !data?.data.length ? (
          <CustomerEmpty
            title="Nenhuma operação por enquanto"
            description="Quando houver registros vinculados à sua conta, eles aparecerão aqui."
          />
        ) : (
          <div className="customer-recent-list">
            {data.data.map((op) => (
              <div className="customer-recent-row" key={op.id}>
                <div className="customer-recent-main">
                  <b>{formatAmount(op.source.amount, "BRL")}</b>
                  <span className="customer-muted">{displayDate(op.created_at)} · Ambiente de testes</span>
                </div>
                <div className="customer-recent-end">
                  <span className={"customer-chip " + statusStyle(op)}>{operationLabel(op)}</span>
                  <Link className="customer-link" to="/app/operacoes/$id" params={{ id: op.id }}>
                    Ver detalhes
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </CustomerPanel>
    </>
  );
}
