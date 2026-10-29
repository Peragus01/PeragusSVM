import { formatAmount } from "@/components/peragus/customer-operations";
import { OnboardingEvidence } from "@/components/peragus/onboarding-evidence";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { usePeragusWallet } from "@/components/peragus/wallet-context";
import {
  normalizePurchaseAmount,
  readPurchasePlan,
  savePurchasePlan,
  purchaseRequest,
  validateQuote,
  validatePurchase,
  PurchaseError,
  type PurchasePlan,
  type Quote,
  type PurchaseRecord,
} from "@/lib/peragus/purchase";
export const Route = createFileRoute("/app/comprar-usdt")({ component: PurchasePage });
function PurchasePage() {
  const { identity, accessToken } = useCustomerSession();
  const wallet = usePeragusWallet();
  return (
    <>
      <SectionTitle
        eyebrow="BRL → USDT / SOLANA"
        title="Comprar USDT"
        description="Consulte uma estimativa e registre sua intenção de compra no ambiente de testes."
      />
      <CustomerNotice kind="warning">
        Cotação indicativa e registro de intenção em sandbox. Esta etapa não gera Pix, não inicia
        retirada e não comprova entrega na carteira. A estimativa não garante câmbio nem valor
        líquido.
      </CustomerNotice>
      <div className="customer-purchase-grid">
        {identity?.customer && accessToken && (
          <PurchaseForm
            key={identity.customer.id}
            customerId={identity.customer.id}
            token={accessToken}
          />
        )}
        <div className="customer-purchase-checks">
          <CustomerPanel title="Antes de continuar">
            <div className="customer-row">
              <span>E-mail</span>
              <b>{identity?.user.email ?? "—"}</b>
            </div>
            <div className="customer-row">
              <span>Perfil cadastral</span>
              <span className="customer-chip">{identity?.customer ? "Existente" : "Pendente"}</span>
            </div>
            <details>
              <summary>Ver cadastro e verificações de identidade</summary>
              <OnboardingEvidence />
            </details>
            <div className="customer-row">
              <span>Carteira neste navegador</span>
              <b style={{ overflowWrap: "anywhere" }}>{wallet.address ?? "Não conectada"}</b>
            </div>
            <div className="customer-row">
              <span>Operações financeiras reais</span>
              <span className="customer-chip customer-chip-warning">
                {identity?.customer?.operations_enabled
                  ? "Sujeita à API de pagamentos"
                  : "Indisponíveis no sandbox"}
              </span>
            </div>
            {!wallet.address && (
              <button
                type="button"
                className="customer-button-secondary"
                style={{ marginTop: 18 }}
                onClick={wallet.open}
              >
                Conectar carteira Devnet
              </button>
            )}
            <p className="customer-muted" style={{ marginTop: 15 }}>
              A carteira existente no repositório utiliza Solana Devnet. Conectar não substitui
              autenticação nem comprova titularidade para operações reais.
            </p>
            <Link to="/app/minha-conta" className="customer-link">
              Ver estado do cadastro e KYC
            </Link>
          </CustomerPanel>
        </div>
      </div>
    </>
  );
}

export function PurchaseForm({ customerId, token }: { customerId: string; token: string }) {
  const [amount, setAmount] = useState("");
  const [plan, setPlan] = useState<PurchasePlan | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [purchase, setPurchase] = useState<PurchaseRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    inFlight.current = false;
    setBusy(false);
    setQuote(null);
    setPurchase(null);
    setReady(false);
    setBlocked(false);
    setError("");
    try {
      const saved = readPurchasePlan(customerId);
      setPlan(saved);
      setAmount(saved?.amount ?? "");
      setReady(true);
    } catch {
      setBlocked(true);
      setError(
        "Não foi possível recuperar os identificadores desta intenção. Preserve os dados desta aba e contate o suporte.",
      );
    }
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [customerId, token]);
  async function run(kind: "quote" | "purchase") {
    if (inFlight.current || !ready || blocked) return;
    const normalized = normalizePurchaseAmount(amount);
    if (!normalized) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const current = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    let next = plan;
    try {
      next ??= {
        customerId,
        amount: normalized,
        quoteRequestId: crypto.randomUUID(),
        purchaseRequestId: crypto.randomUUID(),
        quoteAttempted: false,
        purchaseAttempted: false,
      };
      if (
        kind === "purchase" &&
        (!quote ||
          (!next.purchaseAttempted &&
            quote.expires_at &&
            Date.parse(quote.expires_at) <= Date.now()))
      ) {
        throw new PurchaseError("QUOTE_EXPIRED");
      }
      next = {
        ...next,
        ...(kind === "quote" ? { quoteAttempted: true } : { purchaseAttempted: true }),
      };
      // A failed storage write must prevent a POST with an unrecorded request ID.
      try {
        savePurchasePlan(next);
      } catch {
        setBlocked(true);
        throw new PurchaseError("LOCAL_STORAGE_UNAVAILABLE");
      }
      setPlan(next);
      if (kind === "quote") {
        const raw = await purchaseRequest(
          token,
          next.quoteId ? `quotes/${next.quoteId}` : "quotes",
          next.quoteId
            ? undefined
            : { request_id: next.quoteRequestId, source_amount_brl: next.amount },
          abort.signal,
        );
        if (generation.current !== current) return;
        const result = validateQuote(raw, next);
        next = { ...next, quoteId: result.id };
        savePurchasePlan(next);
        setPlan(next);
        setQuote(result);
      } else if (quote) {
        const raw = await purchaseRequest(
          token,
          next.purchaseId ? `purchase-intents/${next.purchaseId}` : "purchase-intents",
          next.purchaseId ? undefined : { request_id: next.purchaseRequestId, quote_id: quote.id },
          abort.signal,
        );
        if (generation.current !== current) return;
        const result = validatePurchase(raw, next, quote);
        next = { ...next, purchaseId: result.id };
        savePurchasePlan(next);
        setPlan(next);
        setPurchase(result);
      }
    } catch (e) {
      if (generation.current !== current) return;
      if (e instanceof PurchaseError && e.quoteId && next) {
        next = { ...next, quoteId: e.quoteId };
        try {
          savePurchasePlan(next);
          setPlan(next);
        } catch {
          setBlocked(true);
        }
      }
      const code = e instanceof PurchaseError ? e.code : "LOCAL_STORAGE_UNAVAILABLE";
      const messages: Record<string, string> = {
        CUSTOMER_QUOTES_DISABLED: "A consulta de cotações está desativada neste ambiente.",
        CUSTOMER_PURCHASE_INTENTS_DISABLED:
          "O registro de intenções está desativado neste ambiente.",
        QUOTE_EXPIRED:
          "A cotação expirou. Nenhuma intenção nova foi registrada. Contate o suporte para revisar este registro.",
        QUOTE_AMOUNT_INVALID: "O valor foi rejeitado pelos limites atuais da API.",
        LOCAL_STORAGE_UNAVAILABLE:
          "Não foi possível salvar os identificadores. Preserve esta aba e contate o suporte.",
      };
      setError(
        messages[code] ??
          `Não foi possível confirmar o resultado (${code}). Os identificadores foram preservados. Consulte novamente; não há repetição automática.`,
      );
    } finally {
      if (generation.current === current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void run("quote");
  }
  return (
    <CustomerPanel title="Sua intenção de compra">
      <div className="customer-purchase-progress" aria-label="Etapas da intenção">
        <span className={!quote && !purchase ? "active" : ""}>
          <b>1</b> Valor
        </span>
        <i />
        <span className={quote && !purchase ? "active" : ""}>
          <b>2</b> Revisão
        </span>
        <i />
        <span className={purchase ? "active" : ""}>
          <b>3</b> Registro
        </span>
      </div>
      <div className="customer-currency">
        <span>
          <span className="customer-token">R$</span>
          <span>
            Você informa<small>BRL · Real brasileiro</small>
          </span>
        </span>
        <span>Brasil</span>
      </div>
      <form onSubmit={submit} aria-busy={busy}>
        <label className="customer-field customer-purchase-amount">
          Quanto deseja utilizar (BRL)?
          <input
            inputMode="decimal"
            placeholder="Ex.: 1000,00"
            value={amount}
            readOnly={Boolean(plan) || busy}
            onChange={(e) => setAmount(e.target.value)}
            aria-describedby="amount-help"
          />
        </label>
        <p className="customer-muted" id="amount-help">
          Mínimo atual: R$ 1.000,00. A consulta depende dos limites e das condições da sua conta.
        </p>
        <button
          type="submit"
          className="customer-button customer-purchase-submit"
          disabled={
            !ready || blocked || busy || !normalizePurchaseAmount(amount) || Boolean(purchase)
          }
        >
          {busy
            ? "Consultando…"
            : plan?.quoteAttempted
              ? "Consultar cotação desta intenção"
              : "Consultar cotação sandbox"}
        </button>
      </form>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {quote && (
        <>
          <div className="customer-row">
            <span>Valor de origem</span>
            <b>{formatAmount(quote.source.amount, "BRL")}</b>
          </div>
          <div className="customer-row">
            <span>Estimativa indicativa</span>
            <b>{formatAmount(quote.target.amount, "USDT")} · Solana</b>
          </div>
          <div className="customer-row">
            <span>Validade informada</span>
            <b>
              {quote.expires_at
                ? new Date(quote.expires_at).toLocaleString("pt-BR")
                : "Não informada"}
            </b>
          </div>
          <div className="customer-row">
            <span>Custos de entrega / valor líquido</span>
            <b>Não informados</b>
          </div>
          {!purchase && (
            <button
              type="button"
              className="customer-button"
              disabled={busy || blocked}
              onClick={() => void run("purchase")}
            >
              {plan?.purchaseAttempted
                ? "Conferir intenção com o mesmo identificador"
                : "Registrar intenção sandbox"}
            </button>
          )}
        </>
      )}
      {plan && (
        <details className="customer-purchase-reference">
          <summary>Referências desta intenção</summary>
          <p className="customer-muted" style={{ overflowWrap: "anywhere" }}>
            Referência da cotação: {plan.quoteId ?? plan.quoteRequestId}. Referência da intenção:{" "}
            {plan.purchaseId ?? plan.purchaseRequestId}.
          </p>
        </details>
      )}
      {purchase && (
        <button
          type="button"
          className="customer-button-secondary"
          onClick={() => {
            try {
              sessionStorage.removeItem(`peragus-purchase-v1:${customerId}`);
              setPlan(null);
              setQuote(null);
              setPurchase(null);
              setAmount("");
              setError("");
            } catch {
              setBlocked(true);
              setError("Não foi possível preparar outra intenção. Preserve esta aba.");
            }
          }}
        >
          Nova intenção
        </button>
      )}
      {purchase && (
        <CustomerNotice>
          Intenção registrada: {purchase.id}. Nenhum Pix ou envio foi iniciado.{" "}
          <Link to="/app/operacoes" className="customer-link">
            Ver histórico
          </Link>
        </CustomerNotice>
      )}
    </CustomerPanel>
  );
}
