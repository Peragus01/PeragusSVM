import { OnboardingEvidence } from "@/components/peragus/onboarding-evidence";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
export const Route = createFileRoute("/app/minha-conta")({ component: AccountPage });
function AccountPage() {
  const session = useCustomerSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void session.reloadIdentity(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError("Não foi possível atualizar o estado da conta.");
    });
    return () => controller.abort();
    // Reload only once when opening the page or switching authenticated identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.identity?.user.id]);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await session.reloadIdentity();
    } catch {
      setError("Não foi possível atualizar os dados. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }
  const profile = session.identity?.customer;
  return (
    <>
      <SectionTitle
        eyebrow="PERFIL / COMPLIANCE"
        title="Minha conta"
        description="Gerencie sua identidade e acompanhe a análise de verificação."
        action={
          <button
            type="button"
            className="customer-button-secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? "Atualizando…" : "Atualizar status"}
          </button>
        }
      />
      {error && <CustomerNotice kind="danger">{error}</CustomerNotice>}
      <div className="customer-grid-two">
        <CustomerPanel title="Dados da conta">
          <div className="customer-row">
            <span>E-mail</span>
            <b>{session.identity?.user.email ?? "—"}</b>
          </div>
          <div className="customer-row">
            <span>Tipo de perfil</span>
            <b>
              {profile ? (profile.type === "pf" ? "Pessoa física" : "Pessoa jurídica") : "Pendente"}
            </b>
          </div>
          <div className="customer-row">
            <span>Nome cadastrado</span>
            <b>{profile?.display_name ?? "Não disponível"}</b>
          </div>
          <div className="customer-row">
            <span>Conta suspensa</span>
            <b>{profile?.suspended ? "Sim" : "Não"}</b>
          </div>
          <div className="customer-row">
            <span>Operações habilitadas</span>
            <b>{profile?.operations_enabled ? "Informado pela API" : "Não"}</b>
          </div>
          {!profile && (
            <CustomerNotice kind="warning">
              Seu perfil cadastral ainda não está disponível. A criação de perfil por esta tela não
              está habilitada neste piloto.
            </CustomerNotice>
          )}
        </CustomerPanel>
        <CustomerPanel title="Privacidade e segurança">
          <p className="customer-muted">
            Seu acesso é autenticado. Esta página mostra apenas o estado das verificações, sem
            exibir documentos, CPF ou biometria.
          </p>
          <div className="customer-row">
            <span>Autenticação</span>
            <b>E-mail e senha</b>
          </div>
          <div className="customer-row">
            <span>Dados de KYC</span>
            <b>Somente metadados de status</b>
          </div>
          <div className="customer-row">
            <span>Consentimento</span>
            <b>Não solicitado neste módulo</b>
          </div>
          <p className="customer-muted">
            Quando disponível, a verificação documental será realizada em um fluxo seguro do serviço
            responsável.
          </p>
        </CustomerPanel>
      </div>
      <CustomerPanel title="Verificação de identidade (KYC)">
        <OnboardingEvidence />
        <div className="customer-steps">
          {[
            ["1", "Dados cadastrais", "Identificação PF/PJ registrada na conta, quando existente."],
            [
              "2",
              "Documento de identidade",
              "Envio somente em sessão segura hospedada por provedor autorizado.",
            ],
            [
              "3",
              "Análise de conformidade",
              "Status de verificação obtido do backend; sem aprovação local.",
            ],
            [
              "4",
              "Resultado da verificação",
              "Aprovação, rejeição ou solicitação adicional conforme estado real da API.",
            ],
          ].map(([n, t, d]) => (
            <div className="customer-step" key={n}>
              <span className="customer-step-count">{n}</span>
              <div>
                <h3>{t}</h3>
                <p>{d}</p>
              </div>
            </div>
          ))}
        </div>
        <button disabled className="customer-button" type="button">
          Iniciar verificação — integração pendente
        </button>
        <p className="customer-muted" style={{ marginTop: 14 }}>
          O envio de documentos por esta página ainda não está disponível. Você pode consultar acima
          as verificações já registradas.
        </p>
      </CustomerPanel>
    </>
  );
}
