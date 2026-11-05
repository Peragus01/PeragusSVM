import { FileText, ShieldCheck, UserRound } from "lucide-react";
import { Link } from "@tanstack/react-router";

type Props = {
  state: "checking" | "profile_required" | "documents" | "unavailable";
  received: number;
  pending: number;
  canUpload: boolean;
  hasHistory: boolean;
};

export function CustomerKycOverview({ state, received, pending, canUpload, hasHistory }: Props) {
  const linked = state === "documents";
  const profileRequired = state === "profile_required";
  const status = profileRequired
    ? "Cadastro pendente"
    : linked
      ? pending > 0
        ? "Recebimento em acompanhamento"
        : "Continue sua verificação"
      : state === "checking"
        ? "Consultando cadastro"
        : "Consulta indisponível";
  return (
    <section className="customer-kyc-overview" aria-label="Etapas da verificação">
      <div className="customer-kyc-hero">
        <div>
          <span className="customer-eyebrow">VERIFICAÇÃO PESSOAL</span>
          <h2>Uma etapa de cada vez.</h2>
          <p>
            Complete seus dados, envie os documentos solicitados e acompanhe a análise da sua
            identidade.
          </p>
          <span className="customer-kyc-status" role="status">
            {status}
          </span>
        </div>
        <div className="customer-kyc-emblem" aria-hidden="true">
          <ShieldCheck size={72} strokeWidth={1.25} />
        </div>
      </div>
      <ol className="customer-kyc-cards">
        <li data-current={profileRequired || undefined}>
          <div className="customer-kyc-card-heading">
            <UserRound size={24} aria-hidden="true" />
            <span>ETAPA 01</span>
          </div>
          <h3>Dados cadastrais</h3>
          <p>Identificação, endereço e informações sobre seu perfil.</p>
          <strong>
            {linked ? "Dados vinculados" : profileRequired ? "Comece por aqui" : "A consultar"}
          </strong>
        </li>
        <li data-current={linked || undefined}>
          <div className="customer-kyc-card-heading">
            <FileText size={24} aria-hidden="true" />
            <span>ETAPA 02</span>
          </div>
          <h3>Documentos</h3>
          <p>Envie apenas o que foi solicitado e confira o recebimento de cada arquivo.</p>
          <strong>
            {linked
              ? pending > 0
                ? `${pending} envio(s) com recebimento pendente`
                : received > 0
                  ? `${received} arquivo(s) recebido(s)`
                  : "Consulte os documentos solicitados"
              : "Disponível após o envio do cadastro"}
          </strong>
        </li>
        <li>
          <div className="customer-kyc-card-heading">
            <ShieldCheck size={24} aria-hidden="true" />
            <span>ETAPA 03</span>
          </div>
          <h3>Análise de identidade</h3>
          <p>O recebimento dos arquivos é uma etapa da verificação.</p>
          <strong>Resultado em Minha conta</strong>
        </li>
      </ol>
      <div className="customer-kyc-next">
        <div>
          <h3>{profileRequired ? "Vamos começar pelos seus dados?" : "Seu próximo passo"}</h3>
          <p>
            {profileRequired
              ? "Conclua o envio dos dados cadastrais em Minha conta para consultar os documentos solicitados."
              : linked
                ? "Arquivos recebidos continuam sujeitos à análise de identidade."
                : "Consulte o estado do cadastro antes de enviar documentos."}
          </p>
        </div>
        {profileRequired ? (
          <Link to="/app/minha-conta" hash="dados-cadastrais" className="customer-button">
            Continuar cadastro →
          </Link>
        ) : linked ? (
          <a
            href={
              canUpload
                ? "#enviar-documento"
                : hasHistory
                  ? "#historico-documentos"
                  : "#documentos-solicitados"
            }
            className="customer-button"
          >
            {canUpload ? "Enviar documento" : "Acompanhar documentos"}
          </a>
        ) : null}
      </div>
    </section>
  );
}
