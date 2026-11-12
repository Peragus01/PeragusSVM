import { LEGAL_URLS } from "@/lib/peragus/legal-acknowledgement";
import { useEffect, useRef, useState } from "react";
import { CustomerNotice } from "./customer-ui";
import { journeyRequest, journeyMessage, JourneyError } from "@/lib/peragus/journey";
import { moneyMode, useMoneyMode, type MoneyMode } from "@/lib/peragus/config";
// The FX rate lock was refused or did not match: the operation failed and no Pix exists to pay.
const LOCK_FAILURES: Record<string, string> = {
  PIX_RATE_LOCK_UNAVAILABLE:
    "A trava de câmbio não foi concedida. Nenhum Pix foi gerado; faça uma nova cotação.",
  PIX_LOCKED_AMOUNT_MISMATCH:
    "O valor travado não conferiu com a cotação aceita. Nenhum Pix foi gerado; faça uma nova cotação.",
  PIX_RATE_LOCK_REQUIRED:
    "Esta compra não tem uma trava de câmbio aceita. Nenhum Pix foi gerado; faça uma nova cotação.",
};
// Customer cancel before the Pix is confirmed (Política de Reembolso 7.1–7.2).
const CANCEL_FAILURES: Record<string, string> = {
  CANCEL_TOO_LATE_PAYMENT_RECEIVED:
    "O pagamento Pix já foi recebido; o pedido não pode mais ser cancelado por desistência (Política de Reembolso, item 7.2).",
  CANCEL_NOT_ALLOWED: "Este pedido não pode mais ser cancelado.",
};
export const CANCELLED_MESSAGE =
  "Pedido cancelado — se você já pagou, a compra seguirá normalmente.";
type Cancel = { purchase_id: string; status: string; cancel_requested_at: string };
type Pix = {
  id: string;
  purchase_intent_id: string;
  request_id: string;
  environment: MoneyMode;
  real_money: boolean;
  operations_enabled: false;
  payment_confirmed: boolean;
  state: string;
  /** Status of the purchase operation; failed/expired never show instructions. */
  status?: string | null;
  source: { currency: "BRL"; amount: string };
  payment_instructions: {
    br_code: string;
    qr_code_image: string | null;
    expires_at: string;
  } | null;
  subsequent_delivery: { started: false };
  recovery_required: boolean;
  /** Set once the customer asked to cancel; instructions are never shown afterwards. */
  cancel_requested_at?: string | null;
};
export function CustomerPix({
  token,
  purchaseId,
  amount,
  enabled,
}: {
  token: string;
  purchaseId: string;
  amount: string;
  enabled: boolean;
}) {
  const test = useMoneyMode() === "test";
  const [pix, setPix] = useState<Pix | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [cancel, setCancel] = useState<Cancel | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const lock = useRef(false);
  const epoch = useRef(0);
  const storageKey = `peragus-pix-v1:${purchaseId}`;
  const cancelKey = `peragus-cancel-v1:${purchaseId}`;
  useEffect(() => {
    const generation = epoch;
    generation.current++;
    lock.current = false;
    setBusy(false);
    setPix(null);
    setError("");
    setCancel(null);
    setConfirming(false);
    setCancelling(false);
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [token, purchaseId]);
  async function run() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const turn = epoch.current;
    try {
      const text = sessionStorage.getItem(storageKey);
      const saved = text ? JSON.parse(text) : { requestId: crypto.randomUUID() };
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if (!uuid.test(saved.requestId) || (saved.id !== undefined && !uuid.test(saved.id)))
        throw Error();
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
      const data = await journeyRequest<Pix>(
        token,
        saved.id ? `v1/me/sandbox-pix/${saved.id}${pix ? "/reconcile" : ""}` : "v1/me/sandbox-pix",
        saved.id && !pix ? "GET" : "POST",
        saved.id ? undefined : { request_id: saved.requestId, purchase_intent_id: purchaseId },
      );
      if (epoch.current !== turn) return;
      if (
        !data ||
        data.environment !== moneyMode() ||
        data.real_money !== (moneyMode() === "live") ||
        data.operations_enabled !== false ||
        data.purchase_intent_id !== purchaseId ||
        data.request_id !== saved.requestId ||
        data.source?.amount !== amount ||
        data.source.currency !== "BRL" ||
        data.subsequent_delivery?.started !== false ||
        typeof data.payment_confirmed !== "boolean" ||
        !uuid.test(data.id)
      )
        throw Error();
      sessionStorage.setItem(storageKey, JSON.stringify({ ...saved, id: data.id }));
      setPix(data);
    } catch (e) {
      if (epoch.current === turn)
        setError((e instanceof JourneyError && LOCK_FAILURES[e.code]) || journeyMessage(e));
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function requestCancel() {
    if (lock.current) return;
    lock.current = true;
    setCancelling(true);
    setError("");
    const turn = epoch.current;
    try {
      // One request_id per purchase: a repeated click or reload replays the same cancel.
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      const saved = sessionStorage.getItem(cancelKey);
      const requestId = saved && uuid.test(saved) ? saved : crypto.randomUUID();
      sessionStorage.setItem(cancelKey, requestId);
      const data = await journeyRequest<Cancel>(
        token,
        `v1/me/purchase-intents/${purchaseId}/cancel`,
        "POST",
        { request_id: requestId },
      );
      if (epoch.current !== turn) return;
      if (!data || data.purchase_id !== purchaseId || typeof data.cancel_requested_at !== "string")
        throw Error();
      setCancel(data);
      setConfirming(false);
    } catch (e) {
      if (epoch.current === turn) {
        setConfirming(false);
        setError((e instanceof JourneyError && CANCEL_FAILURES[e.code]) || journeyMessage(e));
      }
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setCancelling(false);
      }
    }
  }
  const cancelled = Boolean(cancel || pix?.cancel_requested_at);
  const closed = pix?.status === "failed" || pix?.status === "expired";
  // Cancellable only before the Pix is confirmed (7.1); the server decides with a fresh GET.
  const cancellable =
    !cancelled &&
    !pix?.payment_confirmed &&
    (pix === null || pix.status === "accepted" || pix.status === "awaiting_pix");
  const instructions =
    !closed &&
    !cancelled &&
    // Live: only a verified FX lock (operation awaiting_pix) may be paid.
    (test || pix?.status === "awaiting_pix") &&
    pix?.state === "awaiting_payment" &&
    !pix.recovery_required &&
    !pix.payment_confirmed &&
    pix.payment_instructions &&
    Date.parse(pix.payment_instructions.expires_at) > clock
      ? pix.payment_instructions
      : null;
  return (
    <section className="premium-review">
      <h3>Pagamento Pix</h3>
      <CustomerNotice kind="warning">
        {test
          ? "Somente teste · não pague com dinheiro real. A confirmação de teste não comprova entrega de USDT."
          : "A confirmação do pagamento não comprova a entrega de USDT na sua carteira."}
      </CustomerNotice>
      <p className="customer-muted">
        Antes de pagar, leia a{" "}
        <a href={LEGAL_URLS.refund} target="_blank" rel="noopener noreferrer">
          Política de Reembolso
        </a>
        .
      </p>
      {!enabled && (
        <p className="customer-muted">A criação de Pix está desabilitada pelo servidor.</p>
      )}
      <button
        type="button"
        className="customer-button"
        disabled={busy || cancelling || (!enabled && !pix) || (cancelled && !pix)}
        onClick={() => void run()}
      >
        {busy
          ? "Consultando…"
          : pix
            ? "Atualizar pagamento"
            : test
              ? "Gerar ou recuperar Pix de teste"
              : "Gerar ou recuperar Pix"}
      </button>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {cancelled && !pix?.payment_confirmed && <p role="status">{CANCELLED_MESSAGE}</p>}
      {cancellable && !confirming && (
        <button
          type="button"
          className="customer-button-secondary"
          disabled={busy || cancelling}
          onClick={() => setConfirming(true)}
        >
          Cancelar pedido
        </button>
      )}
      {cancellable && confirming && (
        <div role="dialog" aria-modal="false" aria-labelledby="customer-cancel-title">
          <h4 id="customer-cancel-title">Cancelar pedido?</h4>
          <p className="customer-muted">
            Pela{" "}
            <a href={LEGAL_URLS.refund} target="_blank" rel="noopener noreferrer">
              Política de Reembolso
            </a>{" "}
            (item 7.1), você pode cancelar antes da confirmação do pagamento Pix. Depois que o Pix
            for confirmado, não há cancelamento por desistência (item 7.2). Se você já pagou, a
            compra seguirá normalmente.
          </p>
          <button
            type="button"
            className="customer-button"
            disabled={cancelling}
            onClick={() => void requestCancel()}
          >
            {cancelling ? "Cancelando…" : "Confirmar cancelamento"}
          </button>
          <button
            type="button"
            className="customer-button-secondary"
            disabled={cancelling}
            onClick={() => setConfirming(false)}
          >
            Voltar
          </button>
        </div>
      )}
      {pix && (!cancelled || closed || pix.payment_confirmed) && (
        <p role="status">
          {closed
            ? "Operação encerrada · nenhum Pix para pagar"
            : pix.payment_confirmed
              ? test
                ? "Pagamento confirmado em teste"
                : "Pagamento confirmado"
              : instructions
                ? test
                  ? "Aguardando pagamento de teste"
                  : "Aguardando pagamento"
                : "Pagamento sem instruções válidas para exibição"}{" "}
          · Entrega não iniciada
        </p>
      )}
      {instructions && (
        <>
          <p className="customer-muted">
            Validade: {new Date(instructions.expires_at).toLocaleString("pt-BR")}
          </p>
          {typeof instructions.qr_code_image === "string" &&
            instructions.qr_code_image.length < 200000 &&
            /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(instructions.qr_code_image) && (
              <img
                width="200"
                height="200"
                src={instructions.qr_code_image}
                alt={test ? "QR do Pix de teste" : "QR do Pix"}
              />
            )}
          <label className="customer-field">
            {test ? "Pix copia e cola de teste" : "Pix copia e cola"}
            <textarea readOnly value={instructions.br_code} />
          </label>
          <button
            className="customer-button-secondary"
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(instructions.br_code)
                .then(() => setCopied(true))
                .catch(() => setError("Não foi possível copiar. Selecione o código manualmente."));
            }}
          >
            {copied ? "Código copiado" : test ? "Copiar código de teste" : "Copiar código"}
          </button>
        </>
      )}
    </section>
  );
}
