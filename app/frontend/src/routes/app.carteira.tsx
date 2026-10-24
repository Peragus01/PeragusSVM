import { createFileRoute } from "@tanstack/react-router";
import { CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { usePeragusWallet } from "@/components/peragus/wallet-context";
import { useCustomerSession } from "@/lib/peragus/customer-session";
export const Route = createFileRoute("/app/carteira")({ component: WalletPage });
function WalletPage() {
  const wallet = usePeragusWallet();
  const {identity} = useCustomerSession();
  return <>
    <SectionTitle eyebrow="IDENTIDADE / SOLANA" title="Carteira e identidade" description="Conexão segura de uma carteira para visualizar sua identificação pública."/>
    <CustomerNotice kind="warning">A conexão Wallet Standard existente opera em Devnet. Não representa carteira de recebimento em mainnet e não efetua vinculação de titularidade à conta Peragus.</CustomerNotice>
    <div className="customer-grid-two">
      <CustomerPanel title="Sua carteira">
        <div className="customer-row"><span>Rede disponível</span><b>Solana Devnet</b></div>
        <div className="customer-row"><span>Endereço conectado</span><b style={{overflowWrap:"anywhere"}}>{wallet.address ?? "Não conectado"}</b></div>
        <div className="customer-row"><span>Saldo on-chain</span><b>Não consultado</b></div>
        <div className="customer-row"><span>Comprovação de posse</span><b>Não implementada</b></div>
        <button type="button" className="customer-button" style={{marginTop:18}} onClick={wallet.open}>{wallet.address ? "Gerenciar carteira" : "Conectar carteira"}</button>
        <p className="customer-muted" style={{marginTop:15}}>A Peragus não solicita nem armazena frases-semente ou chaves privadas.</p>
      </CustomerPanel>
      <CustomerPanel title="Estado da identidade">
        <div className="customer-row"><span>Conta autenticada</span><b>{identity?.user.email ?? "—"}</b></div>
        <div className="customer-row"><span>Perfil</span><b>{identity?.customer?.type.toUpperCase() ?? "Não criado"}</b></div>
        <div className="customer-row"><span>Verificação cadastral</span><b>{identity?.customer?.verification_status ?? "Não iniciada"}</b></div>
        <div className="customer-row"><span>Carteira vinculada</span><b>Não verificado</b></div>
        <CustomerNotice>Uma carteira conectada não é prova de titularidade nem autorização para transações.</CustomerNotice>
      </CustomerPanel>
    </div>
  </>;
}
