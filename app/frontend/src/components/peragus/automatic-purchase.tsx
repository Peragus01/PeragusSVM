import { CustomerPix } from "./customer-pix";
import { journeyRequest } from "@/lib/peragus/journey";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowRight, ShieldCheck } from "lucide-react";
import { CustomerNotice } from "./customer-ui";
import { usePeragusWallet } from "./wallet-context";
import { CustomerWalletLink, useLinkedWallet } from "./customer-wallet-link";
import { formatAmount } from "./customer-operations";
import {
  normalizePurchaseAmount,
  purchaseRequest,
  validateQuote,
  validatePurchase,
  PurchaseError,
  type Quote,
  type PurchasePlan,
  type PurchaseRecord,
  readPurchasePlan,
} from "@/lib/peragus/purchase";

type Side = "BRL" | "USDT";
type Receipt = {
  side: Side;
  input: string;
  quoteRequestId: string;
  purchaseRequestId: string;
  quoteId?: string;
  purchaseId?: string;
  sourceAmount?: string;
  purchaseAttempted?: boolean;
};
export function normalizeTarget(input: string) {
  const text = input.trim().replace(",", ".");
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(text)) return null;
  const [w, f = ""] = text.split(".");
  if (BigInt(w!) * 1000000n + BigInt(f.padEnd(6, "0")) <= 0n) return null;
  return `${w}.${f.padEnd(6, "0")}`;
}
const key = (id: string) => `peragus-auto-quote-v1:${id}`;
function persist(id: string, r: Receipt) {
  sessionStorage.setItem(key(id), JSON.stringify(r));
}
function recover(id: string): Receipt | null {
  const text = sessionStorage.getItem(key(id));
  if (!text) {
    const p = readPurchasePlan(id);
    return p
      ? {
          side: "BRL",
          input: p.amount,
          quoteRequestId: p.quoteRequestId,
          purchaseRequestId: p.purchaseRequestId,
          ...(p.quoteId ? { quoteId: p.quoteId } : {}),
          ...(p.purchaseId ? { purchaseId: p.purchaseId } : {}),
          sourceAmount: p.amount,
          purchaseAttempted: p.purchaseAttempted,
        }
      : null;
  }
  const r = JSON.parse(text) as Receipt;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    !r ||
    !["BRL", "USDT"].includes(r.side) ||
    typeof r.input !== "string" ||
    !(r.side === "BRL" ? normalizePurchaseAmount(r.input) : normalizeTarget(r.input)) ||
    !uuid.test(r.quoteRequestId) ||
    !uuid.test(r.purchaseRequestId) ||
    (r.quoteId !== undefined && !uuid.test(r.quoteId)) ||
    (r.purchaseId !== undefined && !uuid.test(r.purchaseId))
  )
    throw Error("INVALID_LOCAL_RECEIPT");
  return r;
}
function normalizeBrlInput(value: string) {
  const result = normalizePurchaseAmount(value);
  return result && BigInt(result.replace(".", "")) <= 1000000n ? result : null;
}
export function AutomaticPurchaseForm({
  customerId,
  token,
}: {
  customerId: string;
  token: string;
}) {
  const wallet = usePeragusWallet();
  const { linked, setLinked, error: walletError } = useLinkedWallet();
  const [capabilities, setCapabilities] = useState<{
    quote: boolean;
    record: boolean;
    pix: boolean;
  } | null>(null);
  const [brl, setBrl] = useState("");
  const [usdt, setUsdt] = useState("");
  const [input, setInput] = useState<{ side: Side; value: string } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [record, setRecord] = useState<PurchaseRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const receipt = useRef<Receipt | null>(null);
  const lock = useRef(false);
  const epoch = useRef(0);
  const currentInput = useRef(input);
  currentInput.current = input;
  useEffect(() => {
    epoch.current++;
    setQuote(null);
    setRecord(null);
    setInput(null);
    setBrl("");
    setUsdt("");
    setError("");
    setReview(false);
    setReady(false);
    setBlocked(false);
    lock.current = false;
    try {
      const saved = recover(customerId);
      receipt.current = saved;
      if (saved) {
        if (saved.side === "BRL") setBrl(saved.input);
        else setUsdt(saved.input);
        setBlocked(true);
        setError(
          "Existe uma solicitação salva. Confira o resultado antes de iniciar outra cotação.",
        );
      }
      setReady(true);
    } catch {
      setBlocked(true);
      setError(
        "Não foi possível recuperar os identificadores. Preserve esta aba e contate o suporte.",
      );
    }
    return () => {
      epoch.current++;
    };
  }, [customerId, token]);
  useEffect(() => {
    const abort = new AbortController();
    setCapabilities(null);
    void journeyRequest<any>(token, "v1/me/purchase-capabilities", "GET", undefined, abort.signal)
      .then((c) => {
        if (abort.signal.aborted) return;
        if (
          c.environment !== "test" ||
          c.operations_enabled !== false ||
          c.real_purchase !== false ||
          c.required_costs_complete !== false ||
          c.network !== "solana:devnet" ||
          !["quote", "record", "pix"].every((k) => typeof c[k] === "boolean")
        )
          throw Error();
        setCapabilities(c);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("Não foi possível confirmar a disponibilidade da compra.");
      });
    return () => abort.abort();
  }, [token]);
  useEffect(() => {
    setReview(false);
  }, [linked?.wallet_address]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const inputError =
    input?.value.trim() &&
    !(input.side === "BRL" ? normalizeBrlInput(input.value) : normalizeTarget(input.value))
      ? input.side === "BRL"
        ? "Informe de R$ 1.000,00 a R$ 10.000,00, com até duas casas decimais."
        : "Informe uma quantidade positiva de USDT, com até seis casas decimais."
      : "";
  const expired = Boolean(quote?.expires_at && Date.parse(quote.expires_at) <= clock);
  function setValue(side: Side, value: string) {
    if (record || receipt.current?.purchaseAttempted) return;
    setQuote(null);
    setReview(false);
    if (side === "BRL") {
      setBrl(value);
      setUsdt("");
    } else {
      setUsdt(value);
      setBrl("");
    }
    setInput({ side, value });
  }
  async function requestQuote(r: Receipt) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const turn = epoch.current;
    try {
      persist(customerId, r);
      receipt.current = r;
      const raw = await purchaseRequest(
        token,
        r.quoteId ? `quotes/${r.quoteId}` : "quotes",
        r.quoteId
          ? undefined
          : {
              request_id: r.quoteRequestId,
              ...(r.side === "BRL"
                ? { source_amount_brl: r.input }
                : { target_amount_usdt: r.input }),
            },
      );
      if (epoch.current !== turn) return;
      const value = raw as Quote;
      const source =
        typeof value?.source?.amount === "string" &&
        /^(0|[1-9]\d{0,4})\.\d{2}$/.test(value.source.amount) &&
        BigInt(value.source.amount.replace(".", "")) > 0n &&
        BigInt(value.source.amount.replace(".", "")) <= 1000000n
          ? value.source.amount
          : null;
      if (
        !source ||
        (r.side === "BRL" && source !== r.input) ||
        (r.side === "USDT" && normalizeTarget(value?.target?.amount ?? "") !== r.input)
      )
        throw new PurchaseError("QUOTE_EVIDENCE_INVALID");
      const plan: PurchasePlan = {
        customerId,
        amount: source,
        quoteRequestId: r.quoteRequestId,
        purchaseRequestId: r.purchaseRequestId,
        quoteAttempted: true,
        purchaseAttempted: r.purchaseAttempted ?? false,
        ...(r.quoteId ? { quoteId: r.quoteId } : {}),
      };
      const q = validateQuote(raw, plan);
      const saved = { ...r, quoteId: q.id, sourceAmount: source };
      persist(customerId, saved);
      receipt.current = saved;
      const latest = currentInput.current;
      const matches =
        !latest ||
        (latest.side === r.side &&
          (r.side === "BRL"
            ? normalizePurchaseAmount(latest.value)
            : normalizeTarget(latest.value)) === r.input);
      setBlocked(false);
      if (matches) {
        setBrl(q.source.amount.replace(".", ","));
        setUsdt(q.target.amount.replace(".", ","));
        setQuote(q);
        setInput(null);
      }
    } catch (e) {
      if (epoch.current !== turn) return;
      const problem =
        e instanceof PurchaseError ? e : new PurchaseError("LOCAL_STORAGE_UNAVAILABLE");
      if (problem.quoteId) {
        const saved = { ...r, quoteId: problem.quoteId };
        try {
          persist(customerId, saved);
          receipt.current = saved;
        } catch {}
      }
      setBlocked(true);
      setError(
        problem.code === "CUSTOMER_QUOTES_DISABLED"
          ? "A cotação está temporariamente indisponível neste ambiente."
          : `Não foi possível confirmar a cotação (${problem.code}). Os identificadores foram preservados; não haverá repetição automática.`,
      );
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (!input || !ready || blocked || busy || record || !capabilities?.quote) return;
    const normalized =
      input.side === "BRL" ? normalizeBrlInput(input.value) : normalizeTarget(input.value);
    if (!normalized) return;
    const timer = setTimeout(() => {
      void requestQuote({
        side: input.side,
        input: normalized,
        quoteRequestId: crypto.randomUUID(),
        purchaseRequestId: crypto.randomUUID(),
      });
    }, 500);
    return () => clearTimeout(timer);
    // Only user edits schedule a new estimate. Derived field updates never do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, ready, blocked, busy, record, capabilities?.quote]);
  async function confirm() {
    const r = receipt.current;
    if (
      !r ||
      !quote ||
      !linked ||
      lock.current ||
      (expired && !r.purchaseAttempted) ||
      !capabilities?.record
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    const turn = epoch.current;
    try {
      const next = { ...r, purchaseAttempted: true };
      persist(customerId, next);
      receipt.current = next;
      const plan: PurchasePlan = {
        customerId,
        amount: quote.source.amount,
        quoteRequestId: r.quoteRequestId,
        purchaseRequestId: r.purchaseRequestId,
        quoteAttempted: true,
        purchaseAttempted: true,
        ...(r.purchaseId ? { purchaseId: r.purchaseId } : {}),
      };
      const raw = await purchaseRequest(
        token,
        r.purchaseId ? `purchase-intents/${r.purchaseId}` : "purchase-intents",
        r.purchaseId ? undefined : { request_id: r.purchaseRequestId, quote_id: quote.id },
      );
      if (epoch.current !== turn) return;
      const p = validatePurchase(raw, plan, quote);
      persist(customerId, { ...next, purchaseId: p.id });
      receipt.current = { ...next, purchaseId: p.id };
      if (p.destination?.wallet_address !== linked.wallet_address)
        throw new PurchaseError("WALLET_BINDING_CONFLICT");
      setRecord(p);
      setReview(false);
    } catch (e) {
      if (epoch.current === turn) {
        setBlocked(true);
        setError(
          `Não foi possível confirmar o registro (${e instanceof PurchaseError ? e.code : "OUTCOME_UNKNOWN"}). Consulte o resultado com os mesmos identificadores.`,
        );
      }
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setBusy(false);
      }
    }
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
      <div className="premium-amount-panel">
        <label htmlFor="automatic-brl">Você paga</label>
        <div className="premium-amount-line">
          <input
            id="automatic-brl"
            aria-describedby="automatic-amount-help"
            aria-invalid={Boolean(inputError && input?.side === "BRL")}
            inputMode="decimal"
            autoComplete="off"
            value={brl}
            readOnly={Boolean(record || receipt.current?.purchaseAttempted)}
            placeholder="0,00"
            onChange={(e) => setValue("BRL", e.target.value)}
          />
          <span className="premium-token-pill">
            <span className="asset-icon brl-icon">R$</span>BRL
          </span>
        </div>
        <span className="premium-amount-caption">Real brasileiro</span>
      </div>
      <div className="premium-conversion-direction" aria-hidden="true">
        <ArrowDown size={18} />
      </div>
      <div className="premium-amount-panel premium-receive">
        <label htmlFor="automatic-usdt">Você recebe · estimativa bruta</label>
        <div className="premium-amount-line">
          <input
            id="automatic-usdt"
            aria-describedby="automatic-amount-help"
            aria-invalid={Boolean(inputError && input?.side === "USDT")}
            inputMode="decimal"
            autoComplete="off"
            value={usdt}
            readOnly={Boolean(record || receipt.current?.purchaseAttempted)}
            placeholder="0,00"
            onChange={(e) => setValue("USDT", e.target.value)}
          />
          <span className="premium-token-pill">
            <span className="asset-icon usdt-icon">₮</span>USDT
          </span>
        </div>
        <span className="premium-amount-caption">
          Solana · não representa USDT líquido garantido
        </span>
      </div>
      {capabilities && !capabilities.quote && (
        <CustomerNotice>A cotação está desabilitada neste ambiente.</CustomerNotice>
      )}
      <p
        id="automatic-amount-help"
        className={"premium-input-help" + (inputError ? " is-invalid" : "")}
      >
        {inputError ||
          "Mínimo atual de entrada: R$ 1.000,00. A estimativa vem do servidor após você digitar."}
      </p>
      {busy && !quote && (
        <div role="status" className="premium-skeleton" aria-label="Atualizando cotação" />
      )}
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {blocked && receipt.current && (
        <button
          type="button"
          className="customer-button-secondary"
          disabled={busy}
          onClick={() => {
            if (receipt.current) void requestQuote(receipt.current);
          }}
        >
          Conferir solicitação salva
        </button>
      )}
      {quote && (
        <div className="premium-review" aria-live="polite">
          <div className="customer-row">
            <span>Total em reais</span>
            <b>{formatAmount(quote.source.amount, "BRL")}</b>
          </div>
          <div className="customer-row">
            <span>Cotação</span>
            <b>1 BRL → {formatAmount(quote.rate, "USDT")}</b>
          </div>
          <div className="customer-row">
            <span>Dedução antes da conversão</span>
            <b>{formatAmount(quote.exchange_conditions?.amount_deducted, "BRL")}</b>
          </div>
          <div className="customer-row">
            <span>Tarifa adicional da Peragus</span>
            <b>
              {typeof quote.exchange_conditions?.spread_bps === "number"
                ? `${quote.exchange_conditions.spread_bps} bps nesta cotação`
                : "Não informada"}
            </b>
          </div>
          <div className="customer-row">
            <span>Tarifa de entrega</span>
            <b>Não informada</b>
          </div>
          <div className="customer-row">
            <span>USDT líquido na carteira</span>
            <b>Não informado</b>
          </div>
          <div className="customer-row">
            <span>Validade</span>
            <b>
              {expired
                ? "Expirada"
                : quote.expires_at
                  ? new Date(quote.expires_at).toLocaleString("pt-BR")
                  : "Indicativa · preço não reservado"}
            </b>
          </div>
          <p className="customer-muted">
            Custos não informados não são zero. A confirmação de uma compra real fica bloqueada
            enquanto faltarem custos e autorização financeira.
          </p>
        </div>
      )}
      <div className="premium-wallet-summary">
        <h3>Carteira vinculada à conta</h3>
        <p className="premium-address">{linked?.wallet_address ?? "Nenhum endereço confirmado"}</p>
        {linked ? (
          <button
            type="button"
            className="customer-button-secondary customer-wallet-action"
            onClick={wallet.open}
          >
            Conectar carteira
          </button>
        ) : (
          <CustomerWalletLink onLinked={setLinked} />
        )}
        <Link to="/app/carteira" className="customer-link">
          {linked ? "Ver minha carteira" : "Adicionar e comprovar carteira"}{" "}
          <ArrowRight size={14} />
        </Link>
        {walletError && <p className="customer-muted">{walletError}</p>}
      </div>
      {!record && (
        <button
          type="button"
          className="customer-button premium-main-action"
          disabled={
            !quote ||
            !normalizePurchaseAmount(quote.source.amount) ||
            busy ||
            blocked ||
            expired ||
            !linked
          }
          onClick={() => setReview(true)}
        >
          Revisar estimativa <ArrowRight size={18} />
        </button>
      )}
      {review && quote && linked && (
        <div className="premium-review" role="region" aria-label="Revisão da compra">
          <h3>Revise antes de confirmar</h3>
          <p>
            {formatAmount(quote.source.amount, "BRL")} → {formatAmount(quote.target.amount, "USDT")}{" "}
            estimados
          </p>
          <p className="premium-address">Destino: {linked.wallet_address} · Solana Devnet</p>
          <CustomerNotice kind="warning">
            Esta confirmação salva apenas um registro de teste. Não gera Pix, não cobra reais e não
            envia USDT.
          </CustomerNotice>
          <button
            type="button"
            className="customer-button"
            disabled={!capabilities?.record || busy || blocked || expired}
            aria-describedby={!capabilities?.record ? "record-unavailable" : undefined}
            onClick={() => void confirm()}
          >
            Confirmar registro de teste
          </button>
          {!capabilities?.record && (
            <p id="record-unavailable" role="status">
              O registro de teste está desabilitado neste ambiente. Você pode revisar a estimativa,
              mas não confirmar uma operação.
            </p>
          )}
        </div>
      )}
      {receipt.current?.purchaseAttempted && !record && quote && (
        <button
          className="customer-button-secondary"
          disabled={busy}
          onClick={() => void confirm()}
        >
          Conferir registro da compra
        </button>
      )}
      {record && (
        <div className="premium-record-success" role="status">
          <h3>Registro de teste salvo</h3>
          <p>Sem cobrança e sem envio de USDT.</p>
          <Link to="/app/operacoes/$id" params={{ id: record.id }} className="customer-link">
            Acompanhar no histórico
          </Link>
          <button
            type="button"
            className="customer-button-secondary"
            onClick={() => {
              try {
                sessionStorage.removeItem(key(customerId));
                sessionStorage.removeItem(`peragus-purchase-v1:${customerId}`);
                receipt.current = null;
                setRecord(null);
                setQuote(null);
                setInput(null);
                setBrl("");
                setUsdt("");
                setBlocked(false);
              } catch {
                setBlocked(true);
              }
            }}
          >
            Nova compra
          </button>
        </div>
      )}
      {record && (
        <CustomerPix
          key={record.id}
          token={token}
          purchaseId={record.id}
          amount={record.source.amount}
          enabled={capabilities?.pix ?? false}
        />
      )}
    </section>
  );
}
