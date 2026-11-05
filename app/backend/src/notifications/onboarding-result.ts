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
  // Encode dynamic values before placing them in HTML attributes or text.
  const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]!);
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atualização do cadastro | Peragus</title></head><body style="margin:0;padding:0;background-color:#f3f6fb;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f6fb"><tr><td align="center" style="padding:48px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#0c1321;border:1px solid #253550;border-radius:18px"><tr><td style="padding:34px 36px 18px"><div style="font-size:22px;font-weight:800;letter-spacing:3px;color:#fff">PERAGUS<span style="color:#5b9dff">.</span></div><div style="font-size:10px;font-weight:700;letter-spacing:2px;color:#95a9c8;margin-top:8px">REAIS. USDT. POSSIBILIDADES.</div></td></tr><tr><td style="padding:28px 36px 38px"><div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#70aaff;margin-bottom:14px">ATUALIZAÇÃO DE CADASTRO · TESTE</div><h1 style="font-size:28px;line-height:1.25;color:#fff;margin:0 0 20px">Atualização do seu cadastro</h1><p style="color:#c4d1e4;font-size:15px;line-height:1.75;margin:0 0 26px">${escape(descriptions[outcome])}</p><table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#326cf4" style="border-radius:9px"><a href="${escape(accountUrl)}" style="display:inline-block;padding:15px 26px;color:#fff;text-decoration:none;font-size:15px;font-weight:700">Acompanhar minha conta</a></td></tr></table><p style="color:#92a4bd;font-size:13px;line-height:1.7;margin:28px 0 0">Não envie documentos, senhas ou códigos por e-mail. Ambiente de testes, sem dinheiro real.</p></td></tr></table><p style="color:#5d6e86;font-size:12px;line-height:1.6;margin:22px 0 6px">Peragus · Mais possibilidades. Menos fronteiras.</p><p style="color:#8090a4;font-size:11px;line-height:1.6;margin:0">Esta é uma mensagem automática. Não responda a este e-mail.</p></td></tr></table></body></html>`;
  return {
    html,
    subject: "[TESTE] Peragus — atualização do cadastro",
    text: `${descriptions[outcome]}\n\nAcesse sua conta: ${accountUrl}\n\nNão envie documentos, senhas ou códigos por e-mail. Ambiente de testes, sem dinheiro real.`,
  };
}
