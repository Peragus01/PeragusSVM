import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { CustomerEmpty, CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { useOperations, formatAmount, operationLabel, statusStyle, displayDate } from "@/components/peragus/customer-operations";
import { useCustomerSession } from "@/lib/peragus/customer-session";
export const Route = createFileRoute("/app/")({ component: CustomerDashboard });
function CustomerDashboard() {
  const {identity} = useCustomerSession();
  const {data,state,error,retry} = useOperations(5);
  const name = identity?.customer?.display_name || identity?.user.email.split("@")[0] || "cliente";
  return <>
    <SectionTitle eyebrow="SUA CENTRAL FINANCEIRA" title={"Olá, " + name + "."} description="Acompanhe seus registros, sua identidade e o estado das integrações em um só lugar." action={<Link to="/app/comprar-usdt" className="customer-button">Comprar USDT <ArrowUpRight size={15}/></Link>}/>
    <CustomerNotice kind="warning">Ambiente de testes. Nenhuma operação financeira ou entrega em mainnet está habilitada nesta interface. Saldos e cotações não são presumidos.</CustomerNotice>
    <div className="customer-grid">
      <div className="customer-panel customer-metric"><span>Verificação de identidade</span><strong>{identity?.customer?.verification_status ?? "Sem perfil"}</strong><small>Estado fornecido pela API de conta</small></div>
      <div className="customer-panel customer-metric"><span>Permissão para operar</span><strong>{identity?.customer?.operations_enabled ? "Consultar condições" : "Bloqueada"}</strong><small>Jamais liberada somente pelo navegador</small></div>
      <div className="customer-panel customer-metric"><span>Registros consultados</span><strong>{state === "ready" ? String(data?.data.length ?? 0) : "—"}</strong><small>Página atual do histórico, não volume total</small></div>
    </div>
    <div className="customer-grid-two">
      <CustomerPanel title="Últimas operações" action={<Link to="/app/operacoes" className="customer-link">Ver histórico <ArrowUpRight size={14}/></Link>}>
        {state === "loading" ? <p role="status" className="customer-muted">Carregando operações…</p> :
         state === "error" ? <><CustomerNotice kind="danger">{error}</CustomerNotice><button type="button" className="customer-button-secondary" onClick={retry}>Tentar novamente</button></> :
         !data?.data.length ? <CustomerEmpty title="Nenhuma operação registrada" description="Seus registros autenticados aparecerão aqui quando estiverem disponíveis."/> :
         data.data.map(op => <div className="customer-row" key={op.id}>
           <div><b>{formatAmount(op.source.amount,"BRL")}</b><div className="customer-muted">{displayDate(op.created_at)} · {op.environment === "test" ? "Teste" : "—"}</div></div>
           <div style={{textAlign:"right"}}><span className={"customer-chip "+statusStyle(op)}>{operationLabel(op)}</span><div style={{marginTop:6}}><Link className="customer-link" to="/app/operacoes/$id" params={{id:op.id}}>Detalhes</Link></div></div>
         </div>)}
      </CustomerPanel>
      <CustomerPanel title="Próximos passos">
        <div className="customer-steps">
          {[["1","Identidade","Confira o status cadastral e de verificação em Minha conta."],["2","Carteira","Conecte uma carteira Solana compatível; isso não autentica sua conta."],["3","Compra","Revise a intenção em BRL. A emissão de Pix permanece indisponível."]].map(([n,t,d]) => <div className="customer-step" key={n}><span className="customer-step-count">{n}</span><div><h3>{t}</h3><p>{d}</p></div></div>)}
        </div>
        <Link to="/app/minha-conta" className="customer-link">Ver minha conta <ArrowUpRight size={14}/></Link>
      </CustomerPanel>
    </div>
  </>;
}
