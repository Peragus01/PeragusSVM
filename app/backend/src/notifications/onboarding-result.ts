import type { OverviewFacts } from "../onboarding/customer-onboarding-overview.js";
export type ReviewState =
  | "not_submitted"
  | "action_required"
  | "pending_identity"
  | "in_review"
  | "approved"
  | "rejected";
export function onboardingReview(f: OverviewFacts): ReviewState {
  if (
    !f.binding_consistent ||
    f.registration?.state !== "linked" ||
    f.terms?.state !== "accepted" ||
    !f.terms.accepted_at
  )
    return "not_submitted";
  const checks = ["kyc_document", "liveness", "face_match"] as const;
  if (
    f.registration.provider_status === "rejected" ||
    (f.identity?.status === "completed" &&
      checks.some((k) => f.identity?.checks[k] === "fail"))
  )
    return "rejected";
  if (
    f.registration.provider_status === "action_required" ||
    f.identity?.status === "expired" ||
    f.registration.requirements_pending === true
  )
    return "action_required";
  if (
    !f.identity ||
    f.identity.status === "pending" ||
    f.identity.status === null
  )
    return "pending_identity";
  if (
    f.registration.provider_status === "approved" &&
    f.registration.verification_mode === "full" &&
    f.registration.requirements_pending === false &&
    f.identity.status === "completed" &&
    checks.every((k) => f.identity?.checks[k] === "pass") &&
    f.screening?.status === "completed" &&
    f.screening.result === "clear" &&
    f.screening.matches_count === 0 &&
    f.screening.suggested_decision === "clear"
  )
    return "approved";
  return "in_review";
}
export type NoticeOutcome = "approved" | "rejected" | "action_required";
export function noticeOutcome(state: ReviewState): NoticeOutcome | null {
  return state === "approved" ||
    state === "rejected" ||
    state === "action_required"
    ? state
    : null;
}
export function notificationMessage(
  outcome: NoticeOutcome,
  accountUrl: string,
) {
  const descriptions = {
    approved:
      "As verificações do seu cadastro foram concluídas no ambiente de testes. Isso não libera compras, pagamentos ou transferências reais.",
    rejected:
      "A análise do seu cadastro de teste foi concluída e o cadastro não foi aprovado. Consulte Minha conta para acompanhar o estado.",
    action_required:
      "Precisamos de uma ação sua para continuar a verificação do cadastro de teste. Consulte Minha conta para ver a pendência.",
  };
  return {
    subject: "[TESTE] Peragus — atualização do cadastro",
    text: `${descriptions[outcome]}\n\nAcesse sua conta: ${accountUrl}\n\nNão envie documentos, senhas ou códigos por e-mail. Ambiente de testes, sem dinheiro real.`,
  };
}
