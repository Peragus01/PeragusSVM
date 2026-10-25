export type RefundState = "pending_review" | "approved" | "rejected" | "refund_recorded";
export interface RefundRequest {
  id: string;
  purchase_intent_id: string;
  pix_id: string;
  request_id: string;
  state: RefundState;
  reason: string;
  requested_amount: { currency: "BRL"; amount: string };
  created_at: string;
  decision_recorded_at: string | null;
  returned_amount: { currency: "BRL"; amount: string } | null;
  partial_refund: boolean | null;
  refund_recorded_at: string | null;
  environment: "test";
  record_only: true;
  refund_execution_automated: false;
  provider_verified: false;
  original_transfer_cancelled: false;
}
export interface OperatorRefund extends RefundRequest {
  customer_id: string;
  decision: { id: string; operator_user_id: string; reason: string } | null;
  completion: { id: string; operator_user_id: string; reference: string } | null;
  withdrawal_context: {
    started: boolean;
    provider_state: string | null;
    requires_manual_funds_review: boolean;
  };
}
export const refundLabels: Record<RefundState, string> = {
  pending_review: "Em análise",
  approved: "Aprovado · devolução pendente",
  rejected: "Pedido não aprovado",
  refund_recorded: "Devolução registrada manualmente",
};
export class RefundError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(refundErrorMessage(code));
  }
}
export function refundErrorMessage(code: string) {
  const messages: Record<string, string> = {
    MANUAL_REFUNDS_DISABLED:
      "Solicitações e decisões estão temporariamente desabilitadas. O acompanhamento continua disponível.",
    REFUND_PAYMENT_NOT_CONFIRMED:
      "O pagamento confirmado ainda não está disponível para análise de estorno.",
    REFUND_ALREADY_REQUESTED: "Já existe um pedido para esta operação. Atualize a consulta.",
    REFUND_ALREADY_DECIDED: "Este pedido já foi analisado. Atualize a consulta.",
    REFUND_IDEMPOTENCY_CONFLICT:
      "Os dados diferem de um registro anterior. Consulte o pedido antes de continuar.",
    WITHDRAWAL_OPERATOR_MFA_REQUIRED: "Confirme o código do autenticador para acessar a análise.",
    AUTH_REQUIRED: "Entre novamente para continuar.",
    VALIDATION_ERROR:
      "Confira o motivo informado; use uma única linha com pelo menos 10 caracteres.",
  };
  return (
    messages[code] ??
    "Não foi possível confirmar o resultado. Consulte o pedido antes de tentar novamente."
  );
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const money = (v: unknown) =>
  record(v) &&
  v["currency"] === "BRL" &&
  typeof v["amount"] === "string" &&
  /^\d{1,19}\.\d{2}$/.test(v["amount"]);
const validId = (id: string) => {
  if (!uuid.test(id)) throw new RefundError("VALIDATION_ERROR", 400);
};
function parseRefund(
  value: unknown,
  operator: boolean,
  expected?: { id?: string; purchase?: string },
): RefundRequest | OperatorRefund {
  if (
    !record(value) ||
    typeof value["id"] !== "string" ||
    !uuid.test(value["id"]) ||
    typeof value["purchase_intent_id"] !== "string" ||
    !uuid.test(value["purchase_intent_id"]) ||
    (expected?.id && value["id"] !== expected.id) ||
    (expected?.purchase && value["purchase_intent_id"] !== expected.purchase) ||
    !Object.hasOwn(refundLabels, String(value["state"])) ||
    typeof value["reason"] !== "string" ||
    !money(value["requested_amount"]) ||
    !(value["returned_amount"] === null || money(value["returned_amount"])) ||
    value["environment"] !== "test" ||
    value["record_only"] !== true ||
    value["refund_execution_automated"] !== false ||
    value["provider_verified"] !== false ||
    value["original_transfer_cancelled"] !== false ||
    !(value["refund_recorded_at"] === null || typeof value["refund_recorded_at"] === "string") ||
    (value["state"] === "refund_recorded"
      ? value["returned_amount"] === null || value["refund_recorded_at"] === null
      : value["returned_amount"] !== null || value["refund_recorded_at"] !== null) ||
    (operator &&
      (!record(value["withdrawal_context"]) ||
        typeof value["withdrawal_context"]["requires_manual_funds_review"] !== "boolean")) ||
    (!operator &&
      ["customer_id", "decision", "completion", "withdrawal_context"].some((key) => key in value))
  )
    throw new RefundError("INVALID_RESPONSE", 200);
  return value as unknown as RefundRequest | OperatorRefund;
}
async function call(
  token: string,
  path: string,
  payload?: object,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!token || token.length > 8185 || !/^[A-Za-z0-9._-]+$/.test(token))
    throw new RefundError("AUTH_REQUIRED", 401);
  try {
    const response = await fetch(`/api${path}`, {
      method: payload ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      ...(signal ? { signal } : {}),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const code = record(body) && record(body["error"]) ? body["error"]["code"] : null;
      throw new RefundError(
        typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
          ? code
          : "REFUND_UNAVAILABLE",
        response.status,
      );
    }
    if (!record(body)) throw new RefundError("INVALID_RESPONSE", response.status);
    return body;
  } catch (error) {
    if (error instanceof RefundError || signal?.aborted) throw error;
    throw new RefundError("REFUND_UNAVAILABLE", 0);
  }
}
export async function getRefund(token: string, purchase: string, signal?: AbortSignal) {
  validId(purchase);
  const body = await call(token, `/v1/me/operations/${purchase}/refund-request`, undefined, signal);
  return parseRefund(body["data"], false, { purchase }) as RefundRequest;
}
export async function requestRefund(
  token: string,
  purchase: string,
  requestId: string,
  reason: string,
  signal?: AbortSignal,
) {
  validId(purchase);
  validId(requestId);
  reason = reason.trim();
  if (
    reason.length < 10 ||
    reason.length > 500 ||
    [...reason].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new RefundError("VALIDATION_ERROR", 400);
  const body = await call(
    token,
    `/v1/me/operations/${purchase}/refund-request`,
    { request_id: requestId, reason },
    signal,
  );
  return parseRefund(body["data"], false, { purchase }) as RefundRequest;
}
export async function listRefunds(token: string, cursor?: string, signal?: AbortSignal) {
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
    throw new RefundError("VALIDATION_ERROR", 400);
  const query = new URLSearchParams({ state: "all", limit: "20", ...(cursor ? { cursor } : {}) });
  const body = await call(token, `/v1/admin/refund-requests?${query}`, undefined, signal);
  if (
    !Array.isArray(body["data"]) ||
    body["data"].length > 20 ||
    !record(body["meta"]) ||
    typeof body["meta"]["has_more"] !== "boolean" ||
    !(body["meta"]["next_cursor"] === null || typeof body["meta"]["next_cursor"] === "string") ||
    (body["meta"]["has_more"] ? !body["meta"]["next_cursor"] : body["meta"]["next_cursor"] !== null)
  )
    throw new RefundError("INVALID_RESPONSE", 200);
  return {
    data: body["data"].map((item) => parseRefund(item, true) as OperatorRefund),
    nextCursor: body["meta"]["next_cursor"] as string | null,
  };
}
export async function decideRefund(
  token: string,
  id: string,
  requestId: string,
  decision: "approved" | "rejected",
  reason: string,
  signal?: AbortSignal,
) {
  validId(id);
  validId(requestId);
  reason = reason.trim();
  if (
    !["approved", "rejected"].includes(decision) ||
    reason.length < 10 ||
    reason.length > 300 ||
    [...reason].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new RefundError("VALIDATION_ERROR", 400);
  const body = await call(
    token,
    `/v1/admin/refund-requests/${id}/decision`,
    {
      request_id: requestId,
      decision,
      reason,
      confirmation: "MANUAL_REVIEW_COMPLETED",
    },
    signal,
  );
  return parseRefund(body["data"], true, { id }) as OperatorRefund;
}
