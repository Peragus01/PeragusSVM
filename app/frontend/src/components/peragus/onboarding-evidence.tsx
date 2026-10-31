import { profileLabel } from "@/lib/peragus/customer-copy";
import { useEffect, useState } from "react";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import {
  evidenceLabels,
  getOnboardingStatus,
  type OnboardingStatus,
} from "@/lib/peragus/onboarding-status";
import { CustomerNotice } from "./customer-ui";
export function OnboardingEvidence() {
  const { accessToken, identity } = useCustomerSession();
  const id = identity?.customer?.id;
  const [value, setValue] = useState<{ token: string; data: OnboardingStatus } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setValue(null);
    setFailed(null);
    if (!accessToken || !id) return;
    const controller = new AbortController();
    void getOnboardingStatus(accessToken, id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setValue({ token: accessToken, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(accessToken);
      });
    return () => controller.abort();
  }, [accessToken, id, attempt]);
  const data = value?.token === accessToken && value?.data.customer.id === id ? value.data : null;
  const labels = data ? evidenceLabels(data) : null;
  return (
    <>
      <div className="customer-row">
        <span>Dados cadastrais</span>
        <b>{profileLabel(identity?.customer?.verification_status)}</b>
      </div>
      {!id ? (
        <CustomerNotice>Perfil cadastral necessário para consultar as verificações.</CustomerNotice>
      ) : failed === accessToken ? (
        <CustomerNotice kind="warning">
          Não foi possível consultar as verificações. Nenhuma aprovação foi inferida.
        </CustomerNotice>
      ) : !data ? (
        <p role="status">Consultando verificações…</p>
      ) : (
        <>
          <div className="customer-row">
            <span>Análise cadastral</span>
            <b>{labels?.provider}</b>
          </div>
          <div className="customer-row">
            <span>Verificação de identidade</span>
            <b>{labels?.identity}</b>
          </div>
          <div className="customer-row">
            <span>Análise de conformidade</span>
            <b>{labels?.screening}</b>
          </div>
          <div className="customer-row">
            <span>Pendências registradas</span>
            <b>{data.pending_steps.length ? data.pending_steps.length : "Nenhuma"}</b>
          </div>
          <CustomerNotice>
            Resultados registrados em ambiente de testes, sem nova validação de atualidade. Essas
            verificações não habilitam compras com dinheiro real.
          </CustomerNotice>
        </>
      )}
      {id && (
        <button
          type="button"
          className="customer-button-secondary"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Atualizar verificações
        </button>
      )}
    </>
  );
}
