import { moneyMode, type MoneyMode } from "./config";
import { addDays, saoPauloDay } from "./operator-labels";
import { parseOperatorRefund } from "./refunds";

/** Shared API helpers of the operator console (/operador/*). Bearer only, same-origin proxy. */
export class OperatorApiError extends Error {
  constructor(
    public readonly code: string,
    /** HTTP status; 0 when the outcome is unknown (network, abort before an answer). */
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
/** Normalizes any thrown value (RefundError included) into an OperatorApiError. */
export function toOperatorError(error: unknown): OperatorApiError {
  if (error instanceof OperatorApiError) return error;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    const value = error as { code: string; httpStatus?: unknown; status?: unknown };
    const status =
      typeof value.httpStatus === "number"
        ? value.httpStatus
        : typeof value.status === "number"
          ? value.status
          : 0;
    return new OperatorApiError(value.code, status);
  }
  return new OperatorApiError("OUTCOME_UNKNOWN", 0);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const invalid = () => new OperatorApiError("INVALID_RESPONSE", 200);
const validation = () => new OperatorApiError("VALIDATION_ERROR", 400);
const singleLine = (value: string, min: number, max: number) =>
  value.length >= min &&
  value.length <= max &&
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function requireId(value: string) {
  if (!uuid.test(value)) throw validation();
}
/** Fails closed when the backend reports another money mode than this deployment. */
function sameMode(value: unknown) {
  if (value !== moneyMode()) throw invalid();
}

export async function operatorRequest(
  token: string,
  path: string,
  options: { method?: "GET" | "POST" | "PUT"; body?: object; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  if (!token || token.length > 8185 || !/^[A-Za-z0-9._-]+$/.test(token))
    throw new OperatorApiError("AUTH_REQUIRED", 401);
  const method = options.method ?? (options.body ? "POST" : "GET");
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new OperatorApiError("OUTCOME_UNKNOWN", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OperatorApiError(
      response.ok ? "INVALID_RESPONSE" : "OUTCOME_UNKNOWN",
      response.status,
    );
  }
  if (!response.ok) {
    const error = record(body) && record(body["error"]) ? body["error"] : {};
    const code =
      typeof error["code"] === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error["code"])
        ? error["code"]
        : "OUTCOME_UNKNOWN";
    const details: Record<string, unknown> = {};
    for (const key of ["remaining_delay_seconds", "provider_code", "day", "key"])
      if (key in error) details[key] = error[key];
    throw new OperatorApiError(code, response.status, details);
  }
  if (!record(body)) throw invalid();
  return body;
}

export type RuntimeControlKey = "new_operations" | "usdt_sends" | "onboarding";
export interface RuntimeControl {
  key: RuntimeControlKey;
  enabled: boolean;
  updated_by: string | null;
  updated_at: string | null;
  environment: MoneyMode;
  changed?: boolean;
}
const controlKeys: RuntimeControlKey[] = ["new_operations", "usdt_sends", "onboarding"];
function parseControl(value: unknown): RuntimeControl {
  if (
    !record(value) ||
    !controlKeys.includes(value["key"] as RuntimeControlKey) ||
    typeof value["enabled"] !== "boolean"
  )
    throw invalid();
  sameMode(value["environment"]);
  return value as unknown as RuntimeControl;
}
export async function getRuntimeControls(token: string, signal?: AbortSignal) {
  const body = await operatorRequest(token, "v1/admin/runtime-controls", signal ? { signal } : {});
  const data = body["data"];
  if (!record(data) || !Array.isArray(data["controls"])) throw invalid();
  sameMode(data["environment"]);
  return data["controls"].map(parseControl);
}
export async function setRuntimeControl(
  token: string,
  key: RuntimeControlKey,
  enabled: boolean,
  reason: string,
  signal?: AbortSignal,
) {
  reason = reason.trim();
  if (!controlKeys.includes(key) || typeof enabled !== "boolean" || !singleLine(reason, 1, 500))
    throw validation();
  const body = await operatorRequest(token, "v1/admin/runtime-controls", {
    method: "PUT",
    body: { key, enabled, reason },
    ...(signal ? { signal } : {}),
  });
  return parseControl(body["data"]);
}

export interface DailyReview {
  day: string;
  reviewed_by: string;
  reviewed_at: string;
  note: string | null;
  changed: boolean;
}
/** Records the review of an ENDED São Paulo day; today/future is refused before any call. */
export async function recordDailyReview(
  token: string,
  day: string,
  note?: string,
  now: Date = new Date(),
  signal?: AbortSignal,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw validation();
  if (day > addDays(saoPauloDay(now), -1))
    throw new OperatorApiError("DAILY_REVIEW_DAY_NOT_ENDED", 409);
  const trimmed = note?.trim();
  if (trimmed && !singleLine(trimmed, 1, 500)) throw validation();
  const body = await operatorRequest(token, "v1/admin/daily-reviews", {
    body: { day, ...(trimmed ? { note: trimmed } : {}) },
    ...(signal ? { signal } : {}),
  });
  const data = body["data"];
  if (!record(data) || data["day"] !== day || typeof data["changed"] !== "boolean") throw invalid();
  sameMode(data["environment"]);
  return data as unknown as DailyReview;
}

export type QueueState =
  | "pending_approval"
  | "approved"
  | "reserved"
  | "uncertain"
  | "processing"
  | "completed"
  | "needs_review";
export interface WithdrawalQueueItem {
  id: string;
  purchase_intent_id: string;
  created_at: string;
  state: QueueState;
  environment: MoneyMode;
  real_money: boolean;
  refund_request: { id: string; state: string } | null;
  source: { currency: "USDT"; amount: string };
  destination: { wallet_address: string; network: "solana"; proof_network: string };
  approval_recorded_at: string | null;
  recovery_required: boolean;
  manual_review_required: boolean;
}
const usdt = /^\d{1,15}\.\d{1,6}$/;
export async function listWithdrawals(
  token: string,
  state: QueueState | "all",
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ state, limit: "50" });
  const body = await operatorRequest(
    token,
    `v1/admin/withdrawal-requests?${query}`,
    signal ? { signal } : {},
  );
  if (!Array.isArray(body["data"])) throw invalid();
  return body["data"].map((item) => {
    if (
      !record(item) ||
      typeof item["id"] !== "string" ||
      !uuid.test(item["id"]) ||
      typeof item["state"] !== "string" ||
      !record(item["source"]) ||
      typeof item["source"]["amount"] !== "string" ||
      !usdt.test(item["source"]["amount"]) ||
      !record(item["destination"]) ||
      typeof item["destination"]["wallet_address"] !== "string"
    )
      throw invalid();
    sameMode(item["environment"]);
    return item as unknown as WithdrawalQueueItem;
  });
}
export async function approveWithdrawal(
  token: string,
  id: string,
  requestId: string,
  reason: string,
  signal?: AbortSignal,
) {
  requireId(id);
  requireId(requestId);
  reason = reason.trim();
  if (!singleLine(reason, 10, 300)) throw validation();
  const body = await operatorRequest(token, `v1/admin/withdrawal-requests/${id}/approval`, {
    body: { request_id: requestId, reason },
    ...(signal ? { signal } : {}),
  });
  if (!record(body["data"])) throw invalid();
  return body["data"];
}

export interface ExecutionView {
  id: string;
  withdrawal_request_id: string;
  state: string;
  environment: MoneyMode;
  source: { currency: "USDT"; amount: string };
  provider_transaction_reference: string | null;
  provider_refusal_code: string | null;
  provider_completed: boolean;
  recovery_required: boolean;
  manual_review_required: boolean;
  onchain_delivery_verified: boolean;
  delivery_status: "verified" | "simulated" | "review" | null;
  delivery_reason: string | null;
  delivered_amount: string | null;
  refused_transfer_found: boolean;
  delivery_pending_reason: string | null;
}
function parseExecution(value: unknown, id: string): ExecutionView {
  if (!record(value) || value["withdrawal_request_id"] !== id || typeof value["state"] !== "string")
    throw invalid();
  sameMode(value["environment"]);
  return value as unknown as ExecutionView;
}
/** The stored execution of a withdrawal, or null when none was reserved yet. */
export async function getExecution(token: string, id: string, signal?: AbortSignal) {
  requireId(id);
  try {
    const body = await operatorRequest(
      token,
      `v1/admin/withdrawal-requests/${id}/execution`,
      signal ? { signal } : {},
    );
    return parseExecution(body["data"], id);
  } catch (error) {
    if (error instanceof OperatorApiError && error.code === "WITHDRAWAL_EXECUTION_NOT_FOUND")
      return null;
    throw error;
  }
}
/** Sends USDT: the confirmation names the mode (LIVE_USDT_SEND moves real money). */
export async function executeWithdrawal(
  token: string,
  id: string,
  requestId: string,
  mode: MoneyMode,
  signal?: AbortSignal,
) {
  requireId(id);
  requireId(requestId);
  const body = await operatorRequest(token, `v1/admin/withdrawal-requests/${id}/execution`, {
    body: {
      request_id: requestId,
      confirmation: mode === "live" ? "LIVE_USDT_SEND" : "SANDBOX_ONLY",
    },
    ...(signal ? { signal } : {}),
  });
  return parseExecution(body["data"], id);
}
/** GET-only provider reconciliation of an attempted send (never sends). */
export async function reconcileWithdrawal(token: string, id: string, signal?: AbortSignal) {
  requireId(id);
  const body = await operatorRequest(
    token,
    `v1/admin/withdrawal-requests/${id}/execution/reconcile`,
    {
      method: "POST",
      ...(signal ? { signal } : {}),
    },
  );
  return parseExecution(body["data"], id);
}

export interface OperatorAlert {
  id: string;
  kind: string;
  severity: "high" | "medium";
  first_recorded_at: string;
  purchase_intent_id: string;
  withdrawal_request_id: string | null;
  refund_request_id: string | null;
}
export async function listAlerts(
  token: string,
  options: { severity?: "all" | "high"; limit?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    severity: options.severity ?? "all",
    limit: String(options.limit ?? 50),
  });
  const body = await operatorRequest(
    token,
    `v1/admin/operational-alerts?${query}`,
    signal ? { signal } : {},
  );
  if (!Array.isArray(body["data"])) throw invalid();
  return body["data"].map((item) => {
    if (!record(item) || typeof item["kind"] !== "string" || typeof item["id"] !== "string")
      throw invalid();
    sameMode(item["environment"]);
    return item as unknown as OperatorAlert;
  });
}

export interface OperatorNotification {
  id: string;
  kind: string;
  severity: string;
  recipient_role: "operator" | "trusted";
  status: "uncertain" | "failed";
  last_error: string | null;
  purchase_id: string | null;
  created_at: string;
  updated_at: string;
}
export async function listNotifications(
  token: string,
  status?: "uncertain" | "failed",
  signal?: AbortSignal,
) {
  const body = await operatorRequest(
    token,
    `v1/admin/operator-notifications${status ? `?status=${status}` : ""}`,
    signal ? { signal } : {},
  );
  if (!Array.isArray(body["data"]) || body["data"].length > 100) throw invalid();
  return body["data"].map((item) => {
    if (
      !record(item) ||
      typeof item["kind"] !== "string" ||
      !["uncertain", "failed"].includes(String(item["status"]))
    )
      throw invalid();
    sameMode(item["environment"]);
    return item as unknown as OperatorNotification;
  });
}

/** Operator refund decision on an operation (purchase id): moves it to refund_pending. */
export async function decideOperationRefund(
  token: string,
  purchaseId: string,
  requestId: string,
  reason: string,
  signal?: AbortSignal,
) {
  requireId(purchaseId);
  requireId(requestId);
  reason = reason.trim();
  if (!singleLine(reason, 10, 500)) throw validation();
  const body = await operatorRequest(token, `v1/admin/operations/${purchaseId}/refund-decision`, {
    body: { request_id: requestId, reason },
    ...(signal ? { signal } : {}),
  });
  const data = body["data"];
  if (!record(data) || data["purchase_intent_id"] !== purchaseId) throw invalid();
  return data as { purchase_intent_id: string; status: "refund_pending" };
}
/** Records a refund executed outside Peragus (OZAV reference); never moves money itself. */
export async function completeRefund(
  token: string,
  refundId: string,
  requestId: string,
  amountBrl: string,
  reference: string,
  signal?: AbortSignal,
) {
  requireId(refundId);
  requireId(requestId);
  reference = reference.trim();
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(amountBrl) || !/[1-9]/.test(amountBrl)) throw validation();
  if (!singleLine(reference, 8, 160)) throw validation();
  const body = await operatorRequest(token, `v1/admin/refund-requests/${refundId}/completion`, {
    body: {
      request_id: requestId,
      amount_brl: amountBrl,
      reference,
      confirmation: "MANUAL_REFUND_EXECUTED_EXTERNALLY",
    },
    ...(signal ? { signal } : {}),
  });
  try {
    return parseOperatorRefund(body["data"], refundId);
  } catch {
    throw invalid();
  }
}
