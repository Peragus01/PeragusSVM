/** pt-BR labels, error messages and time helpers of the operator console (codes stay secondary). */

export const DAILY_REVIEW_TIME_ZONE = "America/Sao_Paulo";
export const REFUND_DEADLINE_HOURS = 24;

/** São Paulo calendar day (YYYY-MM-DD) of an instant. */
export function saoPauloDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DAILY_REVIEW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
/** Calendar arithmetic on a YYYY-MM-DD day. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
/** "1 h 2 min", "2 min 5 s", "59 s". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}
export type DeadlineLevel = "ok" | "warn" | "danger" | "overdue";
/**
 * The published refund policy commits to 24 h; operators are alerted at 12 h (warn) and
 * 20 h (high), the same thresholds as the backend scanner.
 */
export function refundDeadline(startedAt: string, now: Date = new Date()) {
  const elapsed = Math.max(0, (now.getTime() - Date.parse(startedAt)) / 1000);
  const remainingSeconds = Math.round(REFUND_DEADLINE_HOURS * 3600 - elapsed);
  const level: DeadlineLevel =
    remainingSeconds <= 0
      ? "overdue"
      : elapsed >= 20 * 3600
        ? "danger"
        : elapsed >= 12 * 3600
          ? "warn"
          : "ok";
  return { remainingSeconds, level };
}

export const controlLabels: Record<string, string> = {
  new_operations: "Novas operações",
  usdt_sends: "Envios de USDT",
  onboarding: "Cadastros",
};
export const queueStateLabels: Record<string, string> = {
  pending_approval: "Aguardando aprovação",
  approved: "Aprovado",
  reserved: "Reservado para envio",
  uncertain: "Envio com resultado incerto",
  processing: "Em envio",
  completed: "Enviado pelo provedor",
  needs_review: "Em revisão",
};
export const alertKindLabels: Record<string, string> = {
  reconciliation_review: "Conciliação em revisão",
  reconciliation_stalled: "Conciliação parada",
  withdrawal_uncertain: "Envio com resultado incerto",
  withdrawal_review: "Envio em revisão",
  withdrawal_refused_transfer_found: "Envio recusado com transferência encontrada",
  refund_pending_review: "Estorno aguardando análise",
  refund_approved: "Estorno aprovado · devolução pendente",
  operation_review: "Operação em revisão",
  pix_open_after_close: "Pix em aberto após encerramento",
};
export const notificationKindLabels: Record<string, string> = {
  approval: "Saque aprovado",
  execution: "Envio de USDT",
  needs_review: "Operação em revisão",
  refund_pending: "Reembolso pendente",
  refund_completed: "Reembolso registrado",
  operator_refund_decision: "Decisão de reembolso",
  runtime_control_changed: "Chave operacional alterada",
  stuck_operation: "Operação parada",
  webhook_signature_invalid: "Webhook com assinatura inválida",
  reconciliation_mismatch: "Divergência na conciliação",
  pix_open_after_close: "Pix em aberto após encerramento",
  withdrawal_refused_transfer_found: "Envio recusado com transferência encontrada",
  daily_review_missing: "Revisão diária pendente",
};
export const notificationStatusLabels: Record<string, string> = {
  uncertain: "Resultado incerto · não reenviado automaticamente",
  failed: "Falhou · não enviado",
};
export const deliveryStatusLabels: Record<string, string> = {
  verified: "Entrega verificada on-chain",
  simulated: "Envio simulado (ambiente de testes)",
  review: "Entrega em revisão",
};
const deliveryReasons: Record<string, string> = {
  VERIFIED_ONCHAIN: "crédito confirmado na carteira com o mint e o valor esperados",
  SIMULATED: "envio de testes sem transação verificável na devnet",
  NOT_FINALIZED: "transação ainda não finalizada; nova verificação automática",
  RPC_UNAVAILABLE: "RPC indisponível; nova verificação automática",
  NO_TX_HASH: "o provedor ainda não informou a transação",
  SETTLED_TARGET_NOT_REPORTED: "o provedor ainda não informou o valor liquidado",
  TX_FAILED: "a transação falhou on-chain",
  TX_PREDATES_SEND: "a transação é anterior ao envio registrado",
  RECIPIENT_MISMATCH: "o crédito foi para outra carteira",
  MINT_MISMATCH: "nenhum crédito do USDT deste ambiente",
  AMOUNT_MISMATCH: "valor creditado fora da faixa travada (tolerância de rede)",
  ONCHAIN_CREDIT_DIFFERS_FROM_SETTLED:
    "crédito on-chain diferente do valor liquidado pelo provedor",
  TX_HASH_CHANGED: "o provedor informou outra transação",
  TX_HASH_INVALID: "a referência informada não é uma assinatura Solana",
};
/** Leading upper-case code of a stored reason ("CODE: detail" or "CODE"). */
export const reasonCode = (reason: string | null) =>
  reason?.match(/^[A-Z][A-Z0-9_]{1,63}/)?.[0] ?? null;
export function deliveryReasonText(reason: string | null): string | null {
  const code = reasonCode(reason);
  if (!code) return null;
  return deliveryReasons[code] ?? "motivo registrado pelo backend; confira a auditoria";
}

const messages: Record<string, string> = {
  AUTH_REQUIRED: "Entre novamente para continuar.",
  WITHDRAWAL_OPERATOR_REQUIRED: "Esta conta não está autorizada como operadora.",
  WITHDRAWAL_OPERATOR_MFA_REQUIRED: "Confirme o código do autenticador para acessar o console.",
  OPERATOR_MFA_STALE:
    "Por segurança, confirme um código atual do autenticador para concluir esta ação.",
  OPERATOR_ACCOUNT_SEPARATION_REQUIRED:
    "Esta conta possui perfil de cliente. Use uma conta separada de operador.",
  VALIDATION_ERROR: "Confira os campos informados.",
  INVALID_RESPONSE: "Resposta inesperada do backend (ou de outro ambiente). Nada foi exibido.",
  BACKEND_UNAVAILABLE: "Backend indisponível. Consulte o estado antes de repetir.",
  OUTCOME_UNKNOWN:
    "Não foi possível confirmar o resultado. Repita a mesma solicitação ou consulte o estado.",
  OPERATIONS_PAUSED: "A chave operacional correspondente está desligada. Nada foi executado.",
  DAILY_REVIEW_REQUIRED:
    "A revisão diária do dia anterior está pendente; novas operações ficam bloqueadas.",
  RUNTIME_CONTROLS_UNAVAILABLE: "Chaves operacionais indisponíveis no momento.",
  RUNTIME_CONTROL_NOT_FOUND: "Chave operacional não encontrada neste ambiente.",
  DAILY_REVIEW_DAY_NOT_ENDED:
    "O dia escolhido ainda não terminou (horário de São Paulo). Revise apenas dias encerrados.",
  DAILY_REVIEW_DAY_INVALID: "Dia inválido. Escolha um dia encerrado a partir de 2026-01-01.",
  DAILY_REVIEWS_UNAVAILABLE: "Revisão diária indisponível no momento.",
  OPERATIONAL_ALERTS_UNAVAILABLE: "Alertas indisponíveis no momento.",
  OPERATOR_NOTIFICATIONS_UNAVAILABLE: "Lista de notificações indisponível no momento.",
  WITHDRAWAL_QUEUE_UNAVAILABLE: "Fila de saques indisponível no momento.",
  WITHDRAWAL_APPROVAL_NOT_FOUND: "Aprovação não encontrada.",
  WITHDRAWAL_REQUEST_NOT_FOUND: "Saque não encontrado neste ambiente.",
  WITHDRAWAL_OPERATOR_APPROVALS_DISABLED: "Aprovações de saque desabilitadas neste ambiente.",
  SANDBOX_WITHDRAWAL_EXECUTION_DISABLED: "Execução de envios desabilitada neste ambiente.",
  WITHDRAWAL_EXECUTION_NOT_FOUND: "Nenhuma execução registrada para este saque.",
  WITHDRAWAL_EXECUTION_ALREADY_REQUESTED:
    "Já existe uma execução registrada para este saque. Consulte os detalhes.",
  WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED:
    "Pré-requisitos do envio ausentes (aprovação, Pix ou valor travado).",
  WITHDRAWAL_OPERATION_NOT_APPROVED: "A operação não está aprovada para envio.",
  WITHDRAWAL_APPROVER_NO_LONGER_ALLOWED: "Quem aprovou não está mais autorizado. Nada foi enviado.",
  EXECUTION_REQUIRES_SECOND_OPERATOR:
    "Quatro olhos ativo: a execução exige um operador diferente de quem aprovou.",
  DESTINATION_TOKEN_ACCOUNT_MISSING:
    "A carteira de destino não tem conta de token USDT deste ambiente. Nada foi enviado; peça ao cliente para criá-la.",
  DESTINATION_TOKEN_ACCOUNT_FROZEN:
    "A conta de token USDT da carteira de destino está congelada. Nada foi enviado.",
  DESTINATION_TOKEN_ACCOUNT_UNVERIFIED:
    "Não foi possível verificar a conta de token do destino (RPC). Nada foi enviado.",
  DESTINATION_IDENTIFICATION_FAILED:
    "A identificação do destino (Travel Rule) falhou. Nada foi enviado.",
  WITHDRAWAL_FUNDING_NOT_CONFIRMED: "A conversão do Pix ainda não está confirmada no provedor.",
  WITHDRAWAL_BALANCE_INSUFFICIENT: "Saldo insuficiente na carteira gerenciada. Nada foi enviado.",
  WITHDRAWAL_DESTINATION_INVALID: "Destino inválido. Nada foi enviado.",
  WITHDRAWAL_SEND_AMOUNT_INVALID: "Valor de envio inválido. Nada foi enviado.",
  WITHDRAWAL_SEND_REFUSED: "O provedor recusou o envio. A operação foi para revisão.",
  WITHDRAWAL_EXECUTION_REQUIRES_RECOVERY:
    "Resultado do envio incerto. Não repita com outra chave: use “Conciliar” nos detalhes.",
  WITHDRAWAL_PROVIDER_CONTEXT_MISMATCH:
    "O provedor devolveu dados diferentes do envio registrado. Revisão manual.",
  WITHDRAWAL_EXECUTION_CONTEXT_MISMATCH: "Divergência no registro do envio. Nada foi enviado.",
  REFUND_DECISION_UNAVAILABLE: "Decisão de estorno pela operação indisponível neste ambiente.",
  REFUND_DECISION_INVALID: "Confira o motivo (10 a 500 caracteres, uma linha).",
  REFUND_DECISION_NOT_ALLOWED: "O status desta operação não permite decisão de estorno.",
  REFUND_OPERATION_NOT_FOUND: "Operação não encontrada neste ambiente.",
  REFUND_ALREADY_PENDING: "Esta operação já está com estorno pendente.",
  REFUND_CUSTOMER_HAS_OPEN_OPERATION: "O cliente tem outra operação aberta.",
  REFUND_WITHDRAWAL_IN_PROGRESS:
    "A retirada desta operação já foi aprovada ou iniciada; o estorno não pode ser decidido.",
  REFUND_PAYMENT_NOT_CONFIRMED: "O pagamento Pix ainda não está confirmado.",
  REFUND_APPROVAL_REQUIRED: "O pedido precisa estar aprovado antes de registrar a devolução.",
  REFUND_AMOUNT_EXCEEDS_PAYMENT: "O valor devolvido excede o pagamento.",
  REFUND_ALREADY_RECORDED: "A devolução já foi registrada.",
  REFUND_OPERATION_NOT_REFUND_PENDING: "A operação não está com estorno pendente.",
  REFUND_IDEMPOTENCY_CONFLICT:
    "Os dados diferem de um registro anterior. Consulte o pedido antes de continuar.",
  REFUND_REQUEST_NOT_FOUND: "Pedido de estorno não encontrado.",
  MANUAL_REFUNDS_DISABLED: "Estornos manuais desabilitados neste ambiente.",
  MANUAL_REFUNDS_UNAVAILABLE: "Estornos indisponíveis no momento.",
};
/** pt-BR message for a backend code; the code itself is shown on a secondary line. */
export function operatorErrorMessage(code: string, details: Record<string, unknown> = {}): string {
  if (code === "EXECUTION_TOO_EARLY") {
    const seconds = details["remaining_delay_seconds"];
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? `Intervalo mínimo após a aprovação: faltam ${formatDuration(seconds)}. Nada foi enviado.`
      : "Intervalo mínimo após a aprovação ainda não decorreu. Nada foi enviado.";
  }
  return messages[code] ?? "Não foi possível concluir. Consulte o estado antes de repetir.";
}
