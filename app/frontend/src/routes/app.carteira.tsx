import { profileLabel } from "@/lib/peragus/customer-copy";
import { createFileRoute } from "@tanstack/react-router";
import { CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { usePeragusWallet } from "@/components/peragus/wallet-context";
import { useCustomerSession } from "@/lib/peragus/customer-session";
export const Route = createFileRoute("/app/carteira")({ component: WalletPage });
function WalletPage() {
  const wallet = usePeragusWallet();
  const { identity } = useCustomerSession();
  return (
    <>
      <SectionTitle
        eyebrow="SEU ENDEREÇO DE RECEBIMENTO"
        title="Minha carteira"
        description="Conecte sua carteira Solana e confira o endereço público. Suas chaves continuam com você."
      />
      <CustomerNotice kind="warning">
        A conexão disponível usa a rede de testes Solana Devnet. Não envie fundos reais. Conectar a
        carteira aqui não altera o endereço vinculado à sua conta.
      </CustomerNotice>
      <div className="customer-grid-two">
        <CustomerPanel title="Sua carteira">
          <div className="customer-row">
            <span>Rede disponível</span>
            <b>Solana Devnet</b>
          </div>
          <div className="customer-row">
            <span>Endereço conectado</span>
            <b style={{ overflowWrap: "anywhere" }}>{wallet.address ?? "Não conectado"}</b>
          </div>
          <div className="customer-row">
            <span>Saldo da carteira</span>
            <b>Não disponível nesta página</b>
          </div>
          <div className="customer-row">
            <span>Comprovação por esta tela</span>
            <b>Indisponível neste módulo</b>
          </div>
          <button
            type="button"
            className="customer-button"
            style={{ marginTop: 18 }}
            onClick={wallet.open}
          >
            {wallet.address ? "Gerenciar carteira" : "Conectar carteira"}
          </button>
          <p className="customer-muted" style={{ marginTop: 15 }}>
            A Peragus não solicita frases de recuperação ou chaves privadas. Os saldos não são
            consultados nesta página e não representam custódia pela Peragus.
          </p>
        </CustomerPanel>
        <CustomerPanel title="Estado da identidade">
          <div className="customer-row">
            <span>Conta autenticada</span>
            <b>{identity?.user.email ?? "—"}</b>
          </div>
          <div className="customer-row">
            <span>Perfil</span>
            <b>{identity?.customer?.type.toUpperCase() ?? "Não criado"}</b>
          </div>
          <div className="customer-row">
            <span>Perfil cadastral local</span>
            <b>{profileLabel(identity?.customer?.verification_status)}</b>
          </div>
          <div className="customer-row">
            <span>Vínculo consultado nesta tela</span>
            <b>Não disponível nesta página</b>
          </div>
          <CustomerNotice>
            Uma carteira conectada não é prova de titularidade nem autorização para transações.
          </CustomerNotice>
        </CustomerPanel>
      </div>
    </>
  );
}
