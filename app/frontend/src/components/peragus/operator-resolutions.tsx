import { useState } from "react";
import { CustomerNotice, CustomerPanel } from "@/components/peragus/customer-ui";
import {
  ConfirmDialog,
  FreshMfaForm,
  useFreshMfaAction,
  type VerifyMfa,
} from "@/components/peragus/operator-actions";
import {
  reconcileOperationPix,
  resolveOperation,
  type ResolutionAction,
} from "@/lib/peragus/operator-console";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RESOLUTION_LABELS: Record<ResolutionAction, { label: string; help: string }> = {
  "close-unpaid-review": {
    label: "Encerrar revisão sem pagamento",
    help: "Consulta a OZAV (GET) e só encerra como falha se a transfer do Pix terminou sem pagamento.",
  },
  "reverify-delivery": {
    label: "Verificar entrega de novo",
    help: "Reexecuta a verificação on-chain (mesmas regras). Nunca marca entrega à mão.",
  },
  "return-approved-to-review": {
    label: "Voltar aprovada para revisão",
    help: "Para aprovada com bloqueio permanente e sem envio reivindicado; depois, decisão de estorno.",
  },
};

/**
 * Ruling 39 operator resolutions on an operation (fresh TOTP, reason, audited) and the
 * "Reconciliar Pix" read (GET at OZAV + progression, no TOTP).
 */
export function OperatorResolutions({
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
  const [asking, setAsking] = useState<ResolutionAction | null>(null);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const action = useFreshMfaAction(verifyMfa);
  const id = operation.trim();
  const validId = uuid.test(id);
  const valid = validId && reason.trim().length >= 10;
  const busy = action.busy || !!action.pendingId;
  return (
    <CustomerPanel title="Resoluções da operação">
      <p className="customer-muted">
        Ações auditadas para casos parados. Exigem TOTP recente e motivo; repetir não duplica.
      </p>
      {done && <CustomerNotice>{done}</CustomerNotice>}
      {error && <CustomerNotice>{error}</CustomerNotice>}
      <FreshMfaForm action={action} token={token} />
      <label className="customer-field">
        ID da operação (resoluções)
        <input
          required
          spellCheck={false}
          value={operation}
          disabled={busy}
          onChange={(event) => setOperation(event.target.value)}
        />
      </label>
      <button
        className="customer-button"
        type="button"
        disabled={!validId || reconciling}
        onClick={() => {
          setReconciling(true);
          setError("");
          void reconcileOperationPix(token, id)
            .then((result) => {
              setDone(`Pix reconciliado: operação em ${result.status}.`);
              onSaved();
            })
            .catch((e: unknown) =>
              setError(
                `Não foi possível reconciliar (${(e as { code?: string }).code ?? "ERRO"}).`,
              ),
            )
            .finally(() => setReconciling(false));
        }}
      >
        Reconciliar Pix
      </button>
      <label className="customer-field">
        Motivo da resolução
        <input
          required
          minLength={10}
          maxLength={500}
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {(Object.keys(RESOLUTION_LABELS) as ResolutionAction[]).map((key) => (
        <button
          key={key}
          type="button"
          className="customer-button"
          title={RESOLUTION_LABELS[key].help}
          disabled={busy || !valid}
          onClick={() => setAsking(key)}
        >
          {RESOLUTION_LABELS[key].label}
        </button>
      ))}
      {asking && (
        <ConfirmDialog
          title={RESOLUTION_LABELS[asking].label}
          confirmLabel="Confirmar"
          busy={action.busy}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const chosen = asking,
              text = reason;
            void action.start(
              token,
              (accessToken, requestId, signal) =>
                resolveOperation(accessToken, id, chosen, requestId, text, signal),
              (result) => {
                setAsking(null);
                setReason("");
                setDone(
                  `${RESOLUTION_LABELS[chosen].label}: ${result.from_status} → ${result.to_status} (${result.outcome}).`,
                );
                onSaved();
              },
            );
          }}
        >
          <p>
            {RESOLUTION_LABELS[asking].help} Operação {id.slice(0, 8)}.
          </p>
        </ConfirmDialog>
      )}
    </CustomerPanel>
  );
}
