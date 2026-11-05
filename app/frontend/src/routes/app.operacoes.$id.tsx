import { PurchaseTimeline } from "@/components/peragus/purchase-timeline";
import { CustomerRefund } from "@/components/peragus/customer-refund";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  CustomerEmpty,
  CustomerNotice,
  CustomerPanel,
  SectionTitle,
} from "@/components/peragus/customer-ui";
import {
  displayDate,
  formatAmount,
  operationLabel,
  statusStyle,
} from "@/components/peragus/customer-operations";
import {
  getCustomerOperations,
  getCustomerWithdrawalResult,
  type CustomerOperation,
  type CustomerWithdrawalResult,
} from "@/lib/peragus/customer-reads";
import { useCustomerSession } from "@/lib/peragus/customer-session";
export const Route = createFileRoute("/app/operacoes/$id")({ component: CustomerOperationDetail });
function CustomerOperationDetail() {
  const { id } = Route.useParams();
  const { identity } = useCustomerSession();
  return <OperationDetail key={`${identity?.user.id}:${id}`} />;
}
function OperationDetail() {
  const { id } = Route.useParams();
  const { accessToken, identity } = useCustomerSession();
  const [operation, setOperation] = useState<CustomerOperation | null>(null);
  const [result, setResult] = useState<CustomerWithdrawalResult | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setOperation(null);
    setResult(null);
    setStatus("loading");
    setError("");
    async function load() {
      if (!accessToken) throw new Error("Sessão necessária.");
      // No arbitrary owner ID is accepted; the backend determines which records are visible.
      // A bounded scan avoids issuing unbounded requests if an old ID is not in recent history.
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await getCustomerOperations(accessToken, {
          limit: 50,
          ...(cursor ? { cursor } : {}),
          signal: controller.signal,
        });
        const found = page.data.find((item) => item.id.toLowerCase() === id.toLowerCase());
        if (found) {
          if (found.withdrawal?.id) {
            try {
              const detail = await getCustomerWithdrawalResult(
                accessToken,
                found.withdrawal.id,
                controller.signal,
              );
              if (!controller.signal.aborted) setResult(detail);
            } catch {
              if (!controller.signal.aborted)
                setError(
                  "Detalhes da retirada indisponíveis. Os dados básicos continuam visíveis.",
                );
            }
          }
          if (!controller.signal.aborted) {
            setOperation(found);
            setStatus("ready");
          }
          return;
        }
        if (!page.meta.has_more || !page.meta.next_cursor) break;
        cursor = page.meta.next_cursor;
      }
      if (!controller.signal.aborted) {
        setStatus("error");
        setError(
          "Registro não encontrado entre as operações recentes disponíveis para esta conta.",
        );
      }
    }
    void load().catch(() => {
      if (!controller.signal.aborted) {
        setStatus("error");
        setError("Não foi possível consultar os dados da operação.");
      }
    });
    return () => controller.abort();
  }, [id, accessToken, identity?.user.id]);
  return (
    <>
      <SectionTitle
        eyebrow="HISTÓRICO / COMPRA"
        title="Detalhes da transação"
        description="Confira os valores registrados e acompanhe a situação desta operação."
        action={
          <Link className="customer-button-secondary" to="/app/operacoes">
            Voltar
          </Link>
        }
      />
      {status === "loading" && (
        <CustomerPanel>
          <p role="status" className="customer-muted">
            Consultando operação…
          </p>
        </CustomerPanel>
      )}
      {status === "error" && (
        <CustomerPanel>
          <CustomerNotice kind="danger">{error}</CustomerNotice>
          <CustomerEmpty
            title="Operação indisponível"
            description="Por segurança, somente registros pertencentes à sua conta podem ser exibidos."
          />
        </CustomerPanel>
      )}
      {operation && status === "ready" && (
        <>
          <PurchaseTimeline
            paymentConfirmed={Boolean(operation.pix?.conversion_completed)}
            deliveryVerified={operation.onchain_delivery_verified}
            mainnetExecution={operation.mainnet_execution}
            testEnvironment={operation.environment === "test"}
          />
          <div className="customer-details-grid">
            <CustomerPanel title="Resumo">
              <div className="customer-row">
                <span>Identificador</span>
                <b style={{ overflowWrap: "anywhere" }}>{operation.id}</b>
              </div>
              <div className="customer-row">
                <span>Criada em</span>
                <b>{displayDate(operation.created_at)}</b>
              </div>
              <div className="customer-row">
                <span>Valor registrado</span>
                <b>{formatAmount(operation.source.amount, "BRL")}</b>
              </div>
              <div className="customer-row">
                <span>Cotação estimada</span>
                <b>{formatAmount(operation.estimated_target.amount, "USDT")} (indicativo)</b>
              </div>
              <div className="customer-row">
                <span>Valor convertido</span>
                <b>{formatAmount(operation.converted_target?.amount, "USDT")}</b>
              </div>
              <div className="customer-row">
                <span>Estado</span>
                <span className={"customer-chip " + statusStyle(operation)}>
                  {operationLabel(operation)}
                </span>
              </div>
              <div className="customer-row">
                <span>Rede de prova</span>
                <b>{operation.destination.proof_network}</b>
              </div>
              <div className="customer-row">
                <span>Carteira destino</span>
                <b style={{ overflowWrap: "anywhere" }}>{operation.destination.wallet_address}</b>
              </div>
            </CustomerPanel>
            <CustomerPanel title="Pagamento e entrega">
              <CustomerNotice kind="warning">
                Este registro é de teste, sem dinheiro real. O processamento finalizado não comprova
                entrega na carteira.
              </CustomerNotice>
              <div className="customer-row">
                <span>Ambiente</span>
                <b>Testes · Solana Devnet</b>
              </div>
              <details className="premium-technical-details">
                <summary>Detalhes técnicos e suporte</summary>{" "}
                <div className="customer-row">
                  <span>Pix</span>
                  <b>{operation.pix?.state ?? "Sem registro"}</b>
                </div>
                <div className="customer-row">
                  <span>Entrega</span>
                  <b>{operation.withdrawal?.state ?? "Sem registro"}</b>
                </div>
                <div className="customer-row">
                  <span>Processamento finalizado</span>
                  <b>{operation.withdrawal?.provider_completed ? "Sim, em teste" : "Não"}</b>
                </div>
                <div className="customer-row">
                  <span>Entrega on-chain verificada</span>
                  <b>{operation.onchain_delivery_verified ? "Sim" : "Não"}</b>
                </div>
                <p className="customer-muted">
                  ID da transação na Solana: não disponível. Nenhum link de explorador é gerado sem
                  uma confirmação verificável.
                </p>
              </details>
              {result && (
                <>
                  <div className="customer-row">
                    <span>Valor bruto USDT</span>
                    <b>{formatAmount(result.amounts.gross_amount, "USDT")}</b>
                  </div>
                  <div className="customer-row">
                    <span>Valor líquido USDT</span>
                    <b>{formatAmount(result.amounts.net_amount, "USDT")}</b>
                  </div>
                  <div className="customer-row">
                    <span>Taxas deduzidas</span>
                    <b>{formatAmount(result.amounts.deducted_amount, "USDT")}</b>
                  </div>
                </>
              )}
              {error && <CustomerNotice kind="warning">{error}</CustomerNotice>}
            </CustomerPanel>
          </div>
        </>
      )}
      {operation && status === "ready" && accessToken && (
        <CustomerRefund
          key={`${identity?.user.id}:${operation.id}`}
          accessToken={accessToken}
          purchaseId={operation.id}
          hasPix={!!operation.pix}
        />
      )}
    </>
  );
}
