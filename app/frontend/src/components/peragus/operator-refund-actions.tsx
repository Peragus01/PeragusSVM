import { useState, type FormEvent } from "react";
import { CustomerNotice, CustomerPanel } from "@/components/peragus/customer-ui";
import { formatAmount } from "@/components/peragus/customer-operations";
import {
  ConfirmDialog,
  FreshMfaForm,
  useFreshMfaAction,
  type VerifyMfa,
} from "@/components/peragus/operator-actions";
import { completeRefund, decideOperationRefund } from "@/lib/peragus/operator-console";
import { formatDuration, refundDeadline } from "@/lib/peragus/operator-labels";
import { decideRefund, refundLabels, type OperatorRefund } from "@/lib/peragus/refunds";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 24 h policy countdown for an open refund (from the decision, else from the request). */
export function RefundDeadline({ record, now }: { record: OperatorRefund; now?: Date }) {
  if (record.state !== "pending_review" && record.state !== "approved") return null;
  const { remainingSeconds, level } = refundDeadline(
    record.decision_recorded_at ?? record.created_at,
    now ?? new Date(),
  );
  return (
    <span className={`operator-deadline-${level}`}>
      {remainingSeconds > 0
        ? `Prazo de 24 h: restam ${formatDuration(remainingSeconds)}`
        : `Prazo de 24 h vencido há ${formatDuration(-remainingSeconds)}`}
    </span>
  );
}

/** Customer refund request: decision (record only) and, once approved, the completion record. */
export function RefundDecision({
  token,
  record,
  verifyMfa,
  onSaved,
}: {
  token: string;
  record: OperatorRefund;
  verifyMfa: VerifyMfa;
  onSaved: (value: OperatorRefund) => void;
}) {
  const [decision, setDecision] = useState<"approved" | "rejected">("rejected");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const action = useFreshMfaAction(verifyMfa);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed) return;
    const chosen = decision,
      text = reason.trim();
    void action.start(
      token,
      (accessToken, requestId, signal) =>
        decideRefund(accessToken, record.id, requestId, chosen, text, signal),
      onSaved,
    );
  }
  return (
    <CustomerPanel title="Revisão do pedido">
      <p style={{ overflowWrap: "anywhere" }}>{record.reason}</p>
      <p>
        <strong>{refundLabels[record.state]}</strong> <RefundDeadline record={record} />
      </p>
      {record.withdrawal_context.requires_manual_funds_review && (
        <CustomerNotice kind="warning">
          A retirada já foi iniciada. Confira a situação dos fundos e a transferência original antes
          de decidir. Este pedido não cancela a retirada.
        </CustomerNotice>
      )}
      {record.decision && <p>Motivo interno: {record.decision.reason}</p>}
      {record.returned_amount && (
        <p>Devolução registrada: {formatAmount(record.returned_amount.amount, "BRL")}</p>
      )}
      {record.completion && <p>Referência: {record.completion.reference}</p>}
      <FreshMfaForm action={action} token={token} />
      {record.state === "pending_review" && (
        <form onSubmit={submit}>
          <label className="customer-field">
            Decisão
            <select
              value={decision}
              disabled={action.busy || !!action.pendingId}
              onChange={(event) => setDecision(event.target.value as "approved" | "rejected")}
            >
              <option value="rejected">Não aprovar</option>
              <option value="approved">Aprovar análise</option>
            </select>
          </label>
          <label className="customer-field">
            Motivo interno
            <input
              minLength={10}
              maxLength={300}
              required
              value={reason}
              disabled={action.busy || !!action.pendingId}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={action.busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            Conferi o pagamento e a retirada. Esta decisão não realiza uma devolução.
          </label>
          <button
            className="customer-button"
            disabled={action.busy || !!action.pendingId || !confirmed || reason.trim().length < 10}
          >
            {action.busy ? "Registrando decisão…" : "Registrar decisão"}
          </button>
        </form>
      )}
      {record.state === "approved" && (
        <>
          <CustomerNotice>
            Devolução pendente. A execução externa e o registro de conclusão continuam manuais.
          </CustomerNotice>
          <RefundCompletion token={token} record={record} verifyMfa={verifyMfa} onSaved={onSaved} />
        </>
      )}
    </CustomerPanel>
  );
}

/** Records the refund executed outside Peragus (OZAV reference). Never moves money itself. */
function RefundCompletion({
  token,
  record,
  verifyMfa,
  onSaved,
}: {
  token: string;
  record: OperatorRefund;
  verifyMfa: VerifyMfa;
  onSaved: (value: OperatorRefund) => void;
}) {
  const [amount, setAmount] = useState(record.requested_amount.amount);
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [asking, setAsking] = useState(false);
  const action = useFreshMfaAction(verifyMfa);
  const valid =
    /^\d{1,15}(\.\d{1,2})?$/.test(amount) && /[1-9]/.test(amount) && reference.trim().length >= 8;
  return (
    <>
      <FreshMfaForm action={action} token={token} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed && valid) setAsking(true);
        }}
      >
        <label className="customer-field">
          Valor devolvido (R$)
          <input
            inputMode="decimal"
            required
            value={amount}
            disabled={action.busy || !!action.pendingId}
            onChange={(event) => setAmount(event.target.value.trim())}
          />
        </label>
        <label className="customer-field">
          Referência OZAV
          <input
            required
            minLength={8}
            maxLength={160}
            value={reference}
            disabled={action.busy || !!action.pendingId}
            onChange={(event) => setReference(event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />{" "}
          Confirmo que a devolução foi executada fora da Peragus (OZAV) neste valor.
        </label>
        <button
          className="customer-button"
          disabled={action.busy || !!action.pendingId || !confirmed || !valid}
        >
          Registrar devolução
        </button>
      </form>
      {asking && (
        <ConfirmDialog
          title="Registrar devolução"
          confirmLabel="Confirmar registro"
          busy={action.busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            const value = amount,
              ref = reference;
            void action.start(
              token,
              (accessToken, requestId, signal) =>
                completeRefund(accessToken, record.id, requestId, value, ref, signal),
              (saved) => {
                setAsking(false);
                onSaved(saved);
              },
            );
          }}
        >
          <p>
            Registrar {formatAmount(amount, "BRL")} devolvidos com a referência {reference.trim()}?
            O registro é definitivo e move a operação para reembolsada.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Operator refund decision on an operation (needs_review, paid Pix after close, …). */
export function OperationRefundDecision({
  token,
  verifyMfa,
  initialOperation,
  onSaved,
}: {
  token: string;
  verifyMfa: VerifyMfa;
  initialOperation: string;
  onSaved: () => void;
}) {
  const [operation, setOperation] = useState(initialOperation);
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState("");
  const action = useFreshMfaAction(verifyMfa);
  const valid = uuid.test(operation.trim()) && reason.trim().length >= 10;
  return (
    <CustomerPanel title="Decisão de estorno pela operação">
      <p className="customer-muted">
        Para operações em revisão, Pix pago após o encerramento ou ainda não aprovadas para envio.
        Move a operação para estorno pendente; a devolução continua manual.
      </p>
      {done && <CustomerNotice>{done}</CustomerNotice>}
      <FreshMfaForm action={action} token={token} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) setAsking(true);
        }}
      >
        <label className="customer-field">
          ID da operação
          <input
            required
            spellCheck={false}
            value={operation}
            disabled={action.busy || !!action.pendingId}
            onChange={(event) => setOperation(event.target.value)}
          />
        </label>
        <label className="customer-field">
          Motivo do estorno
          <input
            required
            minLength={10}
            maxLength={500}
            value={reason}
            disabled={action.busy || !!action.pendingId}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button className="customer-button" disabled={action.busy || !!action.pendingId || !valid}>
          Registrar decisão de estorno
        </button>
      </form>
      {asking && (
        <ConfirmDialog
          title="Estornar operação"
          confirmLabel="Confirmar estorno"
          busy={action.busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            const id = operation.trim(),
              text = reason;
            void action.start(
              token,
              (accessToken, requestId, signal) =>
                decideOperationRefund(accessToken, id, requestId, text, signal),
              () => {
                setAsking(false);
                setReason("");
                setDone(
                  "Operação movida para estorno pendente. Registre a devolução após executá-la na OZAV (prazo de 24 h).",
                );
                onSaved();
              },
            );
          }}
        >
          <p>
            Estornar a operação {operation.trim().slice(0, 8)}? A decisão é definitiva e bloqueia o
            envio de USDT desta operação.
          </p>
        </ConfirmDialog>
      )}
    </CustomerPanel>
  );
}
