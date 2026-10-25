import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import { CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { verificationCopy } from "@/lib/peragus/customer-ux";

export const Route = createFileRoute("/app/minha-conta")({ component: AccountPage });

function AccountPage() {
  const session = useCustomerSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void session.reloadIdentity(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError("Não foi possível atualizar a situação da conta.");
    });
    return () => controller.abort();
    // We intentionally refresh once on opening and changing the signed-in account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.identity?.user.id]);

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await session.reloadIdentity();
    } catch {
      setError("Não foi possível atualizar seus dados. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  const profile = session.identity?.customer ?? null;
  const verification = verificationCopy(profile);
  const paymentsAvailable = Boolean(profile?.operations_enabled && !profile.suspended);

  return (
    <>
      <SectionTitle
        eyebrow="SUA CONTA / IDENTIDADE"
        title="Minha conta"
        description="Veja seus dados e entenda o andamento da verificação de identidade."
        action={
          <button
            type="button"
            className="customer-button-secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? "Atualizando…" : "Atualizar situação"}
          </button>
        }
      />
      {error && <CustomerNotice kind="danger">{error}</CustomerNotice>}

      <section
        className={"customer-verification-hero tone-" + verification.tone}
        aria-labelledby="customer-verification-title"
      >
        <div className="customer-verification-icon" aria-hidden="true">
          {verification.approved ? <CheckCircle2 size={24} /> : <Clock3 size={24} />}
        </div>
        <div>
          <span className="customer-eyebrow">SITUAÇÃO DA VERIFICAÇÃO</span>
          <h2 id="customer-verification-title">{verification.title}</h2>
          <p>{verification.detail}</p>
          <p className="customer-verification-guidance">{verification.guidance}</p>
          <span className="customer-verification-chip">{verification.label}</span>
        </div>
      </section>

      <div className="customer-grid-two">
        <CustomerPanel title="Informações da sua conta">
          <div className="customer-row">
            <span>E-mail de acesso</span>
            <b>{session.identity?.user.email ?? "Não informado"}</b>
          </div>
          <div className="customer-row">
            <span>Tipo de conta</span>
            <b>
              {profile ? (profile.type === "pf" ? "Pessoa física" : "Pessoa jurídica") : "Ainda não cadastrada"}
            </b>
          </div>
          <div className="customer-row">
            <span>Nome cadastrado</span>
            <b>{profile?.display_name ?? "Não disponível"}</b>
          </div>
          <div className="customer-row">
            <span>Acesso à conta</span>
            <b>{profile?.suspended ? "Restrito" : "Ativo para consulta"}</b>
          </div>
          <div className="customer-row">
            <span>Pagamentos</span>
            <b>{paymentsAvailable ? "Sujeitos à integração de pagamentos" : "Ainda não habilitados"}</b>
          </div>
          {!profile && (
            <CustomerNotice kind="warning">
              O cadastro de perfil ainda não pode ser concluído nesta interface. Nenhuma informação
              será enviada por um formulário sem integração segura.
            </CustomerNotice>
          )}
        </CustomerPanel>
        <CustomerPanel title="Como funciona a verificação">
          <ol className="customer-verification-steps">
            <li>
              <span className="customer-step-count">1</span>
              <div><strong>Informações cadastrais</strong><p>Seus dados são associados à conta autenticada.</p></div>
            </li>
            <li>
              <span className="customer-step-count">2</span>
              <div><strong>Verificação segura</strong><p>Quando estiver disponível, o envio de documentos acontecerá em um fluxo protegido.</p></div>
            </li>
            <li>
              <span className="customer-step-count">3</span>
              <div><strong>Acompanhamento</strong><p>O resultado é confirmado pelo servidor, nunca por um botão no navegador.</p></div>
            </li>
          </ol>
          <div className="customer-inline-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <span>A Peragus não solicita senhas, frases-semente ou documentos por esta tela.</span>
          </div>
          <p className="customer-muted">
            Iniciar ou retomar uma verificação dependerá da integração segura do parceiro. A etapa
            ainda não está disponível no piloto.
          </p>
          <Link to="/app/carteira" className="customer-link">
            Ver minha carteira de testes <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </CustomerPanel>
      </div>
    </>
  );
}
