import { useState } from "react";
import { CustomerNotice, CustomerPanel } from "@/components/peragus/customer-ui";
import {
  ConfirmDialog,
  FreshMfaForm,
  useFreshMfaAction,
  useOperatorRead,
} from "@/components/peragus/operator-actions";
import {
  OperatorMfaGate,
  OperatorRead,
  type OperatorContext,
} from "@/components/peragus/operator-shell";
import { explorerTx, short, useMoneyMode } from "@/lib/peragus/config";
import {
  approveWithdrawal,
  executeWithdrawal,
  getExecution,
  reconcileWithdrawal,
  type ExecutionView,
  type WithdrawalQueueItem,
} from "@/lib/peragus/operator-console";
import {
  deliveryReasonText,
  deliveryStatusLabels,
  reasonCode,
} from "@/lib/peragus/operator-labels";

const signature = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
export const walletPrefix = (address: string) => short(address, 4);

/** Aprovar: reason (10-300), confirmation, fresh request_id, stale-MFA single retry. */
export function ApproveDialog({
  item,
  context,
  onDone,
  onCancel,
}: {
  item: WithdrawalQueueItem;
  context: OperatorContext;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const action = useFreshMfaAction(context.verifyMfa);
  const [reason, setReason] = useState("");
  return (
    <>
      <FreshMfaForm action={action} token={context.token} />
      <ConfirmDialog
        title="Aprovar saque"
        confirmLabel="Confirmar aprovação"
        disabled={reason.trim().length < 10 || !!action.pendingId}
        busy={action.busy}
        onCancel={onCancel}
        onConfirm={() => {
          const text = reason;
          void action.start(
            context.token,
            (token, requestId, signal) =>
              approveWithdrawal(token, item.id, requestId, text, signal),
            () => onDone("Aprovação registrada. O envio respeita o intervalo mínimo configurado."),
          );
        }}
      >
        <p>
          {item.source.amount} USDT para a carteira {walletPrefix(item.destination.wallet_address)}.
          Confira Pix, conversão e carteira antes de aprovar.
        </p>
        <label className="customer-field">
          Motivo da aprovação
          <input
            required
            minLength={10}
            maxLength={300}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </ConfirmDialog>
    </>
  );
}

/** Executar: in live the operator types LIVE_USDT_SEND; delay and destination errors come from the backend. */
export function ExecuteDialog({
  item,
  context,
  onDone,
  onCancel,
}: {
  item: WithdrawalQueueItem;
  context: OperatorContext;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const mode = useMoneyMode();
  const action = useFreshMfaAction(context.verifyMfa);
  const [typed, setTyped] = useState("");
  const live = mode === "live";
  return (
    <>
      <FreshMfaForm action={action} token={context.token} />
      <ConfirmDialog
        title="Executar envio de USDT"
        confirmLabel="Confirmar envio"
        disabled={(live && typed !== "LIVE_USDT_SEND") || (!!action.pendingId && !action.busy)}
        busy={action.busy}
        onCancel={onCancel}
        onConfirm={() =>
          void action.start(
            context.token,
            (token, requestId, signal) =>
              executeWithdrawal(token, item.id, requestId, mode, signal),
            (execution: ExecutionView) =>
              onDone(
                execution.recovery_required
                  ? "Envio solicitado com resultado incerto: use Detalhes → Conciliar."
                  : "Envio solicitado. Acompanhe a verificação de entrega em Detalhes.",
              ),
          )
        }
      >
        <p>
          {item.source.amount} USDT para a carteira {walletPrefix(item.destination.wallet_address)}.
          {item.approval_recorded_at
            ? ` Aprovado em ${new Date(item.approval_recorded_at).toLocaleString("pt-BR")}.`
            : ""}{" "}
          O backend recusa o envio antes do intervalo mínimo após a aprovação e informa quanto
          falta.
        </p>
        {live ? (
          <>
            <CustomerNotice kind="danger">
              Produção: este envio move dinheiro real na Solana mainnet e não pode ser desfeito.
            </CustomerNotice>
            <label className="customer-field">
              Digite LIVE_USDT_SEND para confirmar
              <input
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
          </>
        ) : (
          <p className="customer-muted">Ambiente de testes: confirmação SANDBOX_ONLY.</p>
        )}
      </ConfirmDialog>
    </>
  );
}

/** Stored execution: delivery verification, review reason, explorer link; Conciliar is GET-only. */
export function ExecutionDetails({
  item,
  context,
}: {
  item: WithdrawalQueueItem;
  context: OperatorContext;
}) {
  const mode = useMoneyMode();
  const read = useOperatorRead(context.token, (token, signal) =>
    getExecution(token, item.id, signal),
  );
  const [busy, setBusy] = useState(false);
  const [reconciled, setReconciled] = useState<ExecutionView | null>(null);
  async function reconcile() {
    setBusy(true);
    try {
      setReconciled(await reconcileWithdrawal(context.token, item.id));
    } catch {
      read.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <CustomerPanel title={`Detalhes do saque ${item.id.slice(0, 8)}`}>
      <OperatorMfaGate reads={[read]} context={context} />
      <OperatorRead read={read} loadingText="Consultando execução…">
        {(stored) => {
          const execution = reconciled ?? stored;
          if (!execution) return <p>Nenhuma execução registrada para este saque.</p>;
          const reason = execution.delivery_reason ?? execution.delivery_pending_reason;
          const explanation = deliveryReasonText(reason);
          const reference = execution.provider_transaction_reference;
          return (
            <>
              <p>
                <strong>
                  {execution.delivery_status
                    ? deliveryStatusLabels[execution.delivery_status]
                    : execution.recovery_required
                      ? "Resultado do envio incerto"
                      : "Entrega ainda não verificada"}
                </strong>
                <small className="operator-code">
                  {execution.state}
                  {execution.delivery_status
                    ? ` · delivery_status=${execution.delivery_status}`
                    : ""}
                </small>
              </p>
              {explanation && (
                <p>
                  Motivo: {explanation}
                  <small className="operator-code">{reasonCode(reason)}</small>
                </p>
              )}
              {execution.provider_refusal_code && (
                <CustomerNotice kind="warning">
                  O provedor recusou o envio; a operação está em revisão.
                  <small className="operator-code">{execution.provider_refusal_code}</small>
                </CustomerNotice>
              )}
              {execution.refused_transfer_found && (
                <CustomerNotice kind="danger">
                  Envio recusado, mas uma transferência foi encontrada: dinheiro pode ter saído.
                  Nada é reenviado automaticamente.
                </CustomerNotice>
              )}
              {execution.delivered_amount && <p>Creditado: {execution.delivered_amount} USDT</p>}
              {reference && signature.test(reference) && (
                <p>
                  <a
                    className="customer-link"
                    href={explorerTx(reference, mode)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Ver no explorer ({mode === "live" ? "mainnet" : "devnet"})
                  </a>
                </p>
              )}
              <button
                type="button"
                className="customer-button-secondary"
                disabled={busy}
                onClick={() => void reconcile()}
              >
                Conciliar (consulta ao provedor, sem envio)
              </button>
            </>
          );
        }}
      </OperatorRead>
    </CustomerPanel>
  );
}
