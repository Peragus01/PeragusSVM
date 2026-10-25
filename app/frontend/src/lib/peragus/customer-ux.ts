import type { CustomerProfile } from "./customer-session";

export type Tone = "info" | "warning" | "danger" | "success";
export type VerificationCopy = {
  label: string;
  title: string;
  detail: string;
  guidance: string;
  tone: Tone;
  approved: boolean;
};

/** Human-readable status grounded only in the authoritative /v1/me profile. */
const STATUS: Record<CustomerProfile["verification_status"], VerificationCopy> = {
  draft: {
    label: "Não iniciada",
    title: "Sua verificação ainda não começou",
    detail: "Seu perfil existe, mas a verificação de identidade ainda não foi enviada.",
    guidance:
      "O envio seguro de documentos será disponibilizado quando a integração estiver pronta.",
    tone: "warning",
    approved: false,
  },
  submitted: {
    label: "Dados enviados",
    title: "Recebemos o registro da sua verificação",
    detail: "O servidor registra uma etapa de envio. Consulte aqui as próximas atualizações.",
    guidance: "Não envie documentos por canais externos ou mensagens.",
    tone: "info",
    approved: false,
  },
  in_review: {
    label: "Em análise",
    title: "Estamos analisando sua verificação",
    detail: "Sua identidade está em análise segundo o status retornado pela Peragus.",
    guidance: "Você pode voltar a esta tela para consultar o resultado.",
    tone: "info",
    approved: false,
  },
  action_required: {
    label: "Ação necessária",
    title: "Precisamos de uma atualização",
    detail: "O servidor indica uma pendência de verificação de identidade.",
    guidance:
      "O canal seguro para fornecer os dados solicitados ainda não está disponível nesta interface.",
    tone: "warning",
    approved: false,
  },
  approved: {
    label: "Identidade verificada",
    title: "Sua identidade foi aprovada",
    detail: "Sua verificação de identidade consta como aprovada na API da Peragus.",
    guidance: "A aprovação do cadastro não significa que operações financeiras estão habilitadas.",
    tone: "success",
    approved: true,
  },
  rejected: {
    label: "Não aprovada",
    title: "Sua verificação não foi aprovada",
    detail: "O status retornado pela Peragus indica que a verificação foi rejeitada.",
    guidance:
      "Uma nova análise dependerá de orientação e de um fluxo seguro disponibilizado pela Peragus.",
    tone: "danger",
    approved: false,
  },
};

export function verificationCopy(profile: CustomerProfile | null): VerificationCopy {
  if (!profile) {
    return {
      label: "Perfil pendente",
      title: "Precisamos concluir seu cadastro",
      detail: "Sua conta está autenticada, mas ainda não há um perfil de cliente disponível.",
      guidance:
        "A criação do perfil será liberada quando a integração de cadastro estiver disponível.",
      tone: "warning",
      approved: false,
    };
  }
  if (profile.suspended) {
    return {
      label: "Acesso restrito",
      title: "Sua conta possui uma restrição",
      detail: "Seu perfil consta como suspenso. Não é possível utilizar operações financeiras.",
      guidance: "A restrição deve ser avaliada pelos canais oficiais da Peragus.",
      tone: "danger",
      approved: false,
    };
  }
  return STATUS[profile.verification_status];
}

export type OnboardingStep = {
  key: "session" | "identity" | "wallet";
  title: string;
  detail: string;
  complete: boolean;
  href: "/app/minha-conta" | "/app/carteira";
  action: string;
};
export type OnboardingState = {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  next: OnboardingStep | null;
};

/** Wallet completion means only a Devnet connection, never verified ownership. */
export function onboardingState(
  authenticated: boolean,
  profile: CustomerProfile | null,
  devnetWalletAddress: string | null,
): OnboardingState {
  const status = verificationCopy(profile);
  const steps: OnboardingStep[] = [
    {
      key: "session",
      title: "Acesso à conta",
      detail: authenticated
        ? "Você entrou com sua conta Peragus."
        : "Entre para consultar seus dados com segurança.",
      complete: authenticated,
      href: "/app/minha-conta",
      action: "Ver minha conta",
    },
    {
      key: "identity",
      title: "Verificação de identidade",
      detail: status.approved
        ? "Identidade aprovada no servidor."
        : status.label + " · " + status.guidance,
      complete: status.approved,
      href: "/app/minha-conta",
      action: "Consultar minha verificação",
    },
    {
      key: "wallet",
      title: "Conectar carteira de testes",
      detail: devnetWalletAddress
        ? "Carteira Devnet conectada; posse e rede principal não verificadas."
        : "Conecte uma carteira Solana Devnet para explorar o piloto.",
      complete: Boolean(devnetWalletAddress),
      href: "/app/carteira",
      action: "Ver minha carteira",
    },
  ];
  return {
    steps,
    completed: steps.filter((step) => step.complete).length,
    total: steps.length,
    next: steps.find((step) => !step.complete) ?? null,
  };
}

/**
 * Only parses a preview amount: no quote, transaction limit, fees or Pix are implied.
 * Accepts up to nine whole digits and two decimals, separated by comma or dot.
 */
export function parsePreviewBrl(value: string): number | null {
  const clean = value.trim();
  if (!/^\d{1,9}(?:[,.]\d{1,2})?$/.test(clean)) return null;
  const amount = Number(clean.replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function formatPreviewBrl(amount: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
