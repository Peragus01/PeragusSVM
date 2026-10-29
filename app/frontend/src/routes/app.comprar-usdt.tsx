import { ArrowDown, ArrowRight, Check, Wallet, ShieldCheck } from "lucide-react";
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
  return (
    <>
      <SectionTitle
        eyebrow="REAIS → USDT"
        title="Comprar USDT"
        description="Uma compra simples. Cada etapa no seu tempo."
      />
      <div className="premium-purchase-layout">
        {identity?.customer && accessToken && (
          <PurchaseForm
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
              Disponível agora: consulta e registro de teste. Pix e entrega não são iniciados por
              esta página.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

export function PurchaseForm({ customerId, token }: { customerId: string; token: string }) {
  const wallet = usePeragusWallet();
  const [clock, setClock] = useState(Date.now());
  const [touched, setTouched] = useState(false);
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
        "Não foi possível recuperar os identificadores desta solicitação. Preserve os dados desta aba e contate o suporte.",
      );
    }
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [customerId, token]);
  useEffect(() => {
    if (!quote?.expires_at || purchase) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [quote?.expires_at, purchase]);
  const expired = Boolean(quote?.expires_at && Date.parse(quote.expires_at) <= clock);
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
          "O registro de teste está temporariamente indisponível.",
        QUOTE_EXPIRED:
          "A cotação expirou. Nenhum novo registro foi criado. Consulte o suporte para revisar esta solicitação.",
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
    <section className="premium-buy-card" aria-labelledby="purchase-title">
      <div className="premium-buy-heading">
        <h2 id="purchase-title">Comprar USDT</h2>
        <span className="premium-network">
          <span />
          Solana
        </span>
      </div>
      <p className="premium-test-notice">
        <ShieldCheck size={15} />
        Ambiente de testes · sem dinheiro real
      </p>
      <ol className="premium-flow" aria-label="Etapas da compra">
        {["Valor", "Revisão", "Registro de teste"].map((label, index) => (
          <li
            key={label}
            aria-current={(!quote ? 0 : purchase ? 2 : 1) === index ? "step" : undefined}
          >
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <form onSubmit={submit} aria-busy={busy}>
        <div className="premium-amount-panel">
          <label htmlFor="purchase-amount">
            Você paga <span className="sr-only">Quanto deseja utilizar (BRL)?</span>
          </label>
          <div className="premium-amount-line">
            <input
              id="purchase-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              value={amount}
              readOnly={Boolean(plan) || busy}
              onBlur={() => setTouched(true)}
              onChange={(e) => {
                setAmount(e.target.value);
                setTouched(true);
              }}
              aria-invalid={Boolean(touched && amount && !normalizePurchaseAmount(amount))}
              aria-describedby="amount-help"
            />
            <span className="premium-token-pill">
              <span className="asset-icon brl-icon">R$</span>BRL
            </span>
          </div>
          <span className="premium-amount-caption">
            Real brasileiro · pagamento via Pix quando disponível
          </span>
        </div>
        <div className="premium-conversion-direction" aria-hidden="true">
          <ArrowDown size={18} />
        </div>
        <div
          className={"premium-amount-panel premium-receive" + (busy && !quote ? " is-loading" : "")}
          aria-busy={busy && !quote}
        >
          <span>
            Você recebe <small>Estimativa</small>
          </span>
          <div className="premium-amount-line">
            <output aria-live="polite" aria-label="Estimativa de USDT">
              {busy && !quote ? (
                <span className="premium-skeleton" aria-label="Consultando cotação" />
              ) : quote ? (
                formatAmount(quote.target.amount, "USDT").replace(" USDT", "")
              ) : (
                "—"
              )}
            </output>
            <span className="premium-token-pill">
              <span className="asset-icon usdt-icon">₮</span>USDT
            </span>
          </div>
          <span className="premium-amount-caption">Tether USD · rede Solana</span>
        </div>
        <p
          className={
            "premium-input-help" +
            (touched && amount && !normalizePurchaseAmount(amount) ? " is-invalid" : "")
          }
          id="amount-help"
        >
          {touched && amount && !normalizePurchaseAmount(amount)
            ? "Informe pelo menos R$ 1.000,00, com até duas casas decimais."
            : "Mínimo atual: R$ 1.000,00. Limites e disponibilidade validados pela sua conta."}
        </p>
        {!purchase && (
          <button
            type="submit"
            className="customer-button premium-main-action"
            disabled={!ready || blocked || busy || !normalizePurchaseAmount(amount)}
          >
            {busy
              ? "Consultando…"
              : plan?.quoteAttempted
                ? "Consultar cotação desta solicitação"
                : "Consultar cotação"}
            <ArrowRight size={18} />
          </button>
        )}
      </form>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {quote && (
        <div className="premium-review" key={quote.id}>
          <h3>Revise os valores</h3>
          <div className="customer-row">
            <span>Valor em reais</span>
            <b>{formatAmount(quote.source.amount, "BRL")}</b>
          </div>
          <div className="customer-row">
            <span>Estimativa de conversão</span>
            <b>{formatAmount(quote.target.amount, "USDT")} · Solana</b>
          </div>
          <div className="customer-row">
            <span>Dedução antes da conversão</span>
            <b>{formatAmount(quote.exchange_conditions?.amount_deducted, "BRL")}</b>
          </div>
          <div className="customer-row">
            <span>Taxa de entrega</span>
            <b>Não informada</b>
          </div>
          <div className="customer-row">
            <span>USDT líquido na carteira</span>
            <b>Não informado</b>
          </div>
          <div className="customer-row">
            <span>Validade da cotação</span>
            <b>
              {expired
                ? "Expirada"
                : quote.expires_at
                  ? new Date(quote.expires_at).toLocaleString("pt-BR")
                  : "Indicativa · sem preço reservado"}
            </b>
          </div>
          {expired && (
            <CustomerNotice kind="warning">
              A cotação expirou. Nenhum pagamento será iniciado.
            </CustomerNotice>
          )}
          <p className="customer-muted">
            A estimativa não garante o valor final. Custos não informados não são considerados zero.
            A cotação salva não é atualizada ao consultar novamente.
          </p>
        </div>
      )}
      <div className="premium-wallet-summary">
        <div>
          <Wallet size={19} />
          <h3>Carteira de destino</h3>
        </div>
        {purchase?.destination ? (
          <p className="premium-address">
            {purchase.destination.wallet_address}
            <small>Endereço do registro · Solana Devnet</small>
          </p>
        ) : (
          <p>
            O registro usa o endereço de teste já vinculado à sua conta. Ele será exibido após a
            confirmação do registro. A conexão abaixo não muda esse endereço.
          </p>
        )}
        <button type="button" className="customer-button-secondary" onClick={wallet.open}>
          {wallet.address ? "Gerenciar conexão" : "Conectar carteira de teste"}
        </button>
        {wallet.address && (
          <p className="premium-address">
            {wallet.address}
            <small>Conectada neste navegador · Solana Devnet</small>
          </p>
        )}
        <Link to="/app/carteira" className="customer-link">
          Ver minha carteira <ArrowRight size={14} />
        </Link>
      </div>
      {quote && !purchase && (
        <>
          <p className="premium-confirm-note">
            Você vai salvar um registro de teste. Nenhum Pix será gerado e nenhum USDT será enviado.
          </p>
          <button
            type="button"
            className="customer-button premium-main-action"
            disabled={busy || blocked || (expired && !plan?.purchaseAttempted)}
            onClick={() => void run("purchase")}
          >
            {busy
              ? "Conferindo…"
              : plan?.purchaseAttempted
                ? "Conferir registro existente"
                : "Confirmar registro de teste"}
            <ArrowRight size={18} />
          </button>
        </>
      )}
      {purchase && (
        <div className="premium-record-success" role="status">
          <span>
            <Check size={22} />
          </span>
          <h3>Registro de teste salvo</h3>
          <p>Sem cobrança e sem envio de USDT. Acompanhe este registro no histórico.</p>
          <Link
            to="/app/operacoes/$id"
            params={{ id: purchase.id }}
            className="customer-button-secondary"
          >
            Detalhes da transação <ArrowRight size={16} />
          </Link>
          <ol className="premium-payment-preview">
            <li>Registro de teste salvo</li>
            <li>Pix não iniciado</li>
            <li>Entrega não iniciada</li>
          </ol>
        </div>
      )}
      {plan && (
        <details className="customer-purchase-reference">
          <summary>Detalhes da transação</summary>
          <p className="customer-muted premium-address">
            Referência da cotação: {plan.quoteId ?? plan.quoteRequestId}. Referência do registro:{" "}
            {plan.purchaseId ?? plan.purchaseRequestId}.
          </p>
        </details>
      )}
      {purchase && (
        <button
          type="button"
          className="customer-button-secondary premium-new-purchase"
          onClick={() => {
            try {
              sessionStorage.removeItem(`peragus-purchase-v1:${customerId}`);
              setPlan(null);
              setQuote(null);
              setPurchase(null);
              setAmount("");
              setError("");
              setTouched(false);
            } catch {
              setBlocked(true);
              setError("Não foi possível preparar outro registro. Preserve esta aba.");
            }
          }}
        >
          Nova consulta
        </button>
      )}
      <p className="premium-security-note">
        <ShieldCheck size={14} /> Nunca compartilhe sua frase de recuperação.
      </p>
    </section>
  );
}
