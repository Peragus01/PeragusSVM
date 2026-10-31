import { useEffect, useRef, useState, type FormEvent } from "react";
import { CustomerNotice, CustomerPanel } from "./customer-ui";
import { formatAmount } from "./customer-operations";
import {
  getRefund,
  requestRefund,
  refundLabels,
  RefundError,
  type RefundRequest,
} from "@/lib/peragus/refunds";

/** Mount with key={userId + ':' + purchaseId}; account changes discard all private state. */
export function CustomerRefund({
  accessToken,
  purchaseId,
  hasPix,
}: {
  accessToken: string;
  purchaseId: string;
  hasPix: boolean;
}) {
  const [record, setRecord] = useState<RefundRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const pending = useRef<{ id: string; reason: string } | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const version = useRef(0);
  useEffect(
    () => () => {
      mutation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    const turn = ++version.current;
    setLoading(true);
    setError("");
    void getRefund(accessToken, purchaseId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && turn === version.current) setRecord(value);
      })
      .catch((err) => {
        if (controller.signal.aborted || turn !== version.current) return;
        if (err instanceof RefundError && err.code === "REFUND_REQUEST_NOT_FOUND") setRecord(null);
        else setError(err instanceof RefundError ? err.message : "Consulta indisponível.");
      })
      .finally(() => {
        if (!controller.signal.aborted && turn === version.current) setLoading(false);
      });
    return () => controller.abort();
  }, [accessToken, purchaseId, revision]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.current || busy) return;
    const controller = new AbortController();
    mutation.current = controller;
    ++version.current;
    setBusy(true);
    setLoading(false);
    setError("");
    // Retain exactly the same key/body after an ambiguous failure; never retry automatically.
    const request = pending.current ?? { id: crypto.randomUUID(), reason: reason.trim() };
    pending.current = request;
    try {
      const value = await requestRefund(
        accessToken,
        purchaseId,
        request.id,
        request.reason,
        controller.signal,
      );
      if (!controller.signal.aborted) setRecord(value);
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof RefundError
            ? err.message
            : "Consulte o pedido para confirmar o resultado.",
        );
    } finally {
      if (!controller.signal.aborted) {
        mutation.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <CustomerPanel title="Estorno manual">
      <p className="customer-muted">
        Seu pedido será analisado pela equipe. A solicitação e a aprovação não executam a devolução
        nem cancelam a retirada.
      </p>
      {error && <CustomerNotice kind="warning">{error}</CustomerNotice>}
      {loading && <p role="status">Consultando pedido…</p>}
      {!loading && record && (
        <>
          <p role="status">
            <strong>{refundLabels[record.state]}</strong>
          </p>
          <div className="customer-row">
            <span>Valor solicitado</span>
            <b>{formatAmount(record.requested_amount.amount, "BRL")}</b>
          </div>
          <p style={{ overflowWrap: "anywhere" }}>{record.reason}</p>
          {record.state === "approved" && (
            <CustomerNotice>
              A análise foi aprovada. Ainda não há devolução registrada.
            </CustomerNotice>
          )}
          {record.state === "refund_recorded" && (
            <>
              <div className="customer-row">
                <span>Valor registrado como devolvido</span>
                <b>{formatAmount(record.returned_amount?.amount, "BRL")}</b>
              </div>
              <CustomerNotice>
                Registro manual {record.partial_refund ? "de devolução parcial" : "de devolução"}. A
                confirmação pelo provedor não foi verificada neste fluxo.
              </CustomerNotice>
            </>
          )}
        </>
      )}
      {!loading && !record && !error && !hasPix && (
        <CustomerNotice>A operação ainda não possui um Pix registrado para análise.</CustomerNotice>
      )}
      {!loading && !record && hasPix && (!error || pending.current) && (
        <form onSubmit={(event) => void submit(event)}>
          <label className="customer-field">
            Motivo do pedido
            <input
              required
              minLength={10}
              maxLength={500}
              value={reason}
              disabled={busy || !!pending.current}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {pending.current && (
            <p className="customer-muted">
              Uma tentativa já foi feita. Consulte o pedido ou repita os mesmos dados.
            </p>
          )}
          <button
            className="customer-button"
            type="submit"
            disabled={busy || reason.trim().length < 10}
          >
            {busy
              ? "Registrando pedido…"
              : pending.current
                ? "Repetir mesmo pedido"
                : "Solicitar análise de estorno"}
          </button>
        </form>
      )}
      <button
        type="button"
        className="customer-button-secondary"
        disabled={busy || loading}
        onClick={() => setRevision((value) => value + 1)}
      >
        Atualizar consulta
      </button>
    </CustomerPanel>
  );
}
