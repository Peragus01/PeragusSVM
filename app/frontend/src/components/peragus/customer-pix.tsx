import { useEffect, useRef, useState } from "react";
import { CustomerNotice } from "./customer-ui";
import { journeyRequest, journeyMessage } from "@/lib/peragus/journey";
type Pix = {
  id: string;
  purchase_intent_id: string;
  request_id: string;
  environment: "test";
  real_money: false;
  operations_enabled: false;
  payment_confirmed: boolean;
  state: string;
  source: { currency: "BRL"; amount: string };
  payment_instructions: {
    br_code: string;
    qr_code_image: string | null;
    expires_at: string;
  } | null;
  subsequent_delivery: { started: false };
  recovery_required: boolean;
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
  const [pix, setPix] = useState<Pix | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const lock = useRef(false);
  const epoch = useRef(0);
  const storageKey = `peragus-pix-v1:${purchaseId}`;
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    setBusy(false);
    setPix(null);
    setError("");
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      epoch.current++;
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
        data.environment !== "test" ||
        data.real_money !== false ||
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
      if (epoch.current === turn) setError(journeyMessage(e));
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const instructions =
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
        Somente teste · não pague com dinheiro real. A confirmação de teste não comprova entrega de
        USDT.
      </CustomerNotice>
      {!enabled && (
        <p className="customer-muted">A criação de Pix está desabilitada pelo servidor.</p>
      )}
      <button
        type="button"
        className="customer-button"
        disabled={busy || (!enabled && !pix)}
        onClick={() => void run()}
      >
        {busy ? "Consultando…" : pix ? "Atualizar pagamento" : "Gerar ou recuperar Pix de teste"}
      </button>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {pix && (
        <p role="status">
          {pix.payment_confirmed
            ? "Pagamento confirmado em teste"
            : instructions
              ? "Aguardando pagamento de teste"
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
                alt="QR do Pix de teste"
              />
            )}
          <label className="customer-field">
            Pix copia e cola de teste
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
            {copied ? "Código copiado" : "Copiar código de teste"}
          </button>
        </>
      )}
    </section>
  );
}
