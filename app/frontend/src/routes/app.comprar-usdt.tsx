import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { usePeragusWallet } from "@/components/peragus/wallet-context";
export const Route = createFileRoute("/app/comprar-usdt")({ component: PurchasePage });
function PurchasePage() {
  const {identity} = useCustomerSession();
  const wallet = usePeragusWallet();
  const [amount,setAmount] = useState("");
  const [review,setReview] = useState(false);
  const parsed = Number(amount.replace(",","."));
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= 500 && /^\d+([,.]\d{1,2})?$/.test(amount);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid) setReview(true);
  }
  return <>
    <SectionTitle eyebrow="BRL → USDT / SOLANA" title="Comprar USDT" description="Uma experiência clara do valor em reais até o recebimento na sua carteira, quando o serviço estiver habilitado."/>
    <CustomerNotice kind="warning">Prévia operacional sem execução financeira. Este frontend não gera cobrança Pix, não reserva cotação e não realiza compras. Valores de conversão e taxas só serão mostrados quando fornecidos por uma API autorizada.</CustomerNotice>
    <div className="customer-grid-two">
      <CustomerPanel title="Sua intenção de compra">
        <form onSubmit={submit}>
          <label className="customer-field">Quanto deseja utilizar (BRL)?
            <input type="text" inputMode="decimal" placeholder="Ex.: 250,00" value={amount} onChange={event=>{setReview(false);setAmount(event.target.value);}} aria-describedby="amount-help"/>
          </label>
          <p className="customer-muted" id="amount-help">Referência para avaliação do piloto: até R$ 500. Este não é um limite operacional confirmado pelo servidor.</p>
          <div className="customer-row"><span>Moeda de origem</span><b>BRL · Real brasileiro</b></div>
          <div className="customer-row"><span>Moeda de destino</span><b>USDT · rede Solana</b></div>
          <div className="customer-row"><span>Cotação</span><b>Indisponível</b></div>
          <div className="customer-row"><span>Taxas</span><b>Não informadas</b></div>
          <div className="customer-row"><span>USDT estimado</span><b>Não calculado</b></div>
          <button type="submit" className="customer-button" disabled={!valid} style={{marginTop:21}}>Revisar intenção</button>
          {!valid && amount && <p className="customer-muted" role="status">Insira um valor positivo até R$ 500, com no máximo duas casas decimais.</p>}
        </form>
      </CustomerPanel>
      <CustomerPanel title="Verificações antes de continuar">
        <div className="customer-row"><span>E-mail</span><b>{identity?.user.email ?? "—"}</b></div>
        <div className="customer-row"><span>Perfil cadastral</span><span className="customer-chip">{identity?.customer ? "Existente" : "Pendente"}</span></div>
        <div className="customer-row"><span>Verificação KYC</span><span className="customer-chip customer-chip-warning">{identity?.customer?.verification_status ?? "Não cadastrada"}</span></div>
        <div className="customer-row"><span>Carteira Solana</span><b style={{overflowWrap:"anywhere"}}>{wallet.address ?? "Não conectada"}</b></div>
        <div className="customer-row"><span>Autorização de operações</span><span className="customer-chip customer-chip-warning">{identity?.customer?.operations_enabled ? "Sujeita à API de pagamentos" : "Bloqueada"}</span></div>
        {!wallet.address && <button type="button" className="customer-button-secondary" style={{marginTop:18}} onClick={wallet.open}>Conectar carteira Devnet</button>}
        <p className="customer-muted" style={{marginTop:15}}>A carteira existente no repositório utiliza Solana Devnet. Conectar não substitui autenticação nem comprova titularidade para operações reais.</p>
        <Link to="/app/minha-conta" className="customer-link">Ver estado do cadastro e KYC</Link>
      </CustomerPanel>
    </div>
    {review && <CustomerPanel title="Revisão da intenção">
      <CustomerNotice>Você informou R$ {parsed.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}. Nenhuma cotação foi contratada e nenhum pagamento foi iniciado.</CustomerNotice>
      <div className="customer-steps">
        {[["1","Confirmar identidade","Aprovação de perfil e KYC pelo backend."],["2","Obter cotação","Cotação e taxas fornecidas por serviço autorizado."],["3","Receber instrução Pix","Somente após a API confirmar que a operação pode ser executada."],["4","Acompanhar entrega","Acompanhar estados reais de Pix, conversão e Solana."]].map(([n,t,d])=><div className="customer-step" key={n}><span className="customer-step-count">{n}</span><div><h3>{t}</h3><p>{d}</p></div></div>)}
      </div>
      <button disabled type="button" className="customer-button">Gerar Pix — integração não disponível</button>
    </CustomerPanel>}
  </>;
}
