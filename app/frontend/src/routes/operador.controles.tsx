import { createFileRoute } from "@tanstack/react-router";
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
  OperatorShell,
  type OperatorContext,
} from "@/components/peragus/operator-shell";
import {
  getRuntimeControls,
  setRuntimeControl,
  type RuntimeControl,
} from "@/lib/peragus/operator-console";
import { controlLabels } from "@/lib/peragus/operator-labels";

export const Route = createFileRoute("/operador/controles")({ component: RuntimeControlsPage });
function RuntimeControlsPage() {
  return (
    <OperatorShell
      title="Chaves operacionais"
      description="Uma pausa nunca cancela nem move uma operação já iniciada."
    >
      {(context) => <RuntimeControlsConsole {...context} />}
    </OperatorShell>
  );
}

const effects: Record<string, string> = {
  new_operations: "Cotação, aceite e geração de Pix.",
  usdt_sends: "Envio de USDT de saques aprovados (a aprovação continua permitida).",
  onboarding: "Envio de cadastro e início da verificação.",
};

/** GET/PUT /v1/admin/runtime-controls: every change needs a reason and a confirmation. */
export function RuntimeControlsConsole(context: OperatorContext) {
  const { token, verifyMfa } = context;
  const read = useOperatorRead(token, (accessToken, signal) =>
    getRuntimeControls(accessToken, signal),
  );
  const action = useFreshMfaAction(verifyMfa);
  const [target, setTarget] = useState<RuntimeControl | null>(null);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState("");
  function confirm() {
    if (!target) return;
    const key = target.key,
      enabled = !target.enabled,
      text = reason;
    void action.start(
      token,
      (accessToken, _requestId, signal) =>
        setRuntimeControl(accessToken, key, enabled, text, signal),
      (result) => {
        setSaved(
          `${controlLabels[result.key]}: ${result.enabled ? "ligada" : "desligada"}${result.changed === false ? " (já estava assim)" : ""}.`,
        );
        setTarget(null);
        setReason("");
        read.reload();
      },
    );
  }
  return (
    <>
      {saved && <CustomerNotice>{saved}</CustomerNotice>}
      <FreshMfaForm action={action} token={token} />
      <OperatorMfaGate reads={[read]} context={context} />
      <OperatorRead read={read} loadingText="Consultando chaves…">
        {(controls) => (
          <CustomerPanel title="Chaves">
            {controls.map((control) => (
              <div className="customer-row" key={control.key}>
                <span>
                  <strong>{controlLabels[control.key]}</strong>
                  <br />
                  {control.enabled ? "Ligada" : "Desligada"} · {effects[control.key]}
                  <small className="operator-code">
                    {control.key}
                    {control.updated_at
                      ? ` · alterada em ${new Date(control.updated_at).toLocaleString("pt-BR")}`
                      : ""}
                  </small>
                </span>
                <button
                  type="button"
                  className="customer-button-secondary"
                  disabled={action.busy || !!action.pendingId}
                  onClick={() => {
                    setSaved("");
                    setReason("");
                    setTarget(control);
                  }}
                >
                  {control.enabled ? "Desligar" : "Ligar"}
                </button>
              </div>
            ))}
            <p className="customer-muted">
              O backend não expõe o histórico de alterações; cada mudança é auditada no banco e gera
              e-mail ao operador e à pessoa de confiança.
            </p>
          </CustomerPanel>
        )}
      </OperatorRead>
      {target && (
        <ConfirmDialog
          title={`${target.enabled ? "Desligar" : "Ligar"} ${controlLabels[target.key]?.toLowerCase()}`}
          confirmLabel="Confirmar alteração"
          disabled={!reason.trim()}
          busy={action.busy}
          onConfirm={confirm}
          onCancel={() => setTarget(null)}
        >
          <p>{effects[target.key]}</p>
          <label className="customer-field">
            Motivo da alteração
            <input
              required
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}
