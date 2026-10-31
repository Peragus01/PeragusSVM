import { CustomerProfileEditor } from "@/components/peragus/customer-profile-editor";
import { CustomerOnboarding } from "@/components/peragus/customer-onboarding";
import { OnboardingEvidence } from "@/components/peragus/onboarding-evidence";
import { createFileRoute, Link } from "@tanstack/react-router";
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
        eyebrow="CADASTRO E SEGURANÇA"
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
          {profile && <CustomerProfileEditor key={session.identity?.user.id} />}
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
            <b>Status das verificações</b>
          </div>
          <div className="customer-row">
            <span>Consentimento</span>
            <b>Não solicitado nesta página</b>
          </div>
          <p className="customer-muted">
            Quando disponível, a verificação documental será realizada em um fluxo seguro do serviço
            responsável.
          </p>
        </CustomerPanel>
      </div>
      <div className="premium-support-link">
        <Link to="/app/auditoria" className="customer-link">
          Detalhes da transação e suporte →
        </Link>
      </div>
      <CustomerOnboarding key={session.identity?.user.id} />
    </>
  );
}
