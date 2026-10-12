/** Typed client for the Peragus backend contract. React components never call fetch directly. */

export type SettlementStatus =
  | "created"
  | "awaiting_pix"
  | "pix_confirmed"
  | "tokenized"
  | "settling"
  | "settled"
  | "offramping"
  | "paid_out"
  | "failed"
  | "revoked";

export const LIFECYCLE: SettlementStatus[] = [
  "created",
  "awaiting_pix",
  "pix_confirmed",
  "tokenized",
  "settling",
  "settled",
  "offramping",
  "paid_out",
];
export const TERMINAL = new Set<SettlementStatus>(["paid_out", "failed", "revoked"]);

export interface Settlement {
  id: string;
  request_id: string;
  corridor_id: string;
  payer_wallet: string;
  recipient_wallet: string;
  source_amount: string;
  destination_amount: string;
  expires_at: string;
  status: SettlementStatus;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface Money {
  amount: string;
  currency: string;
}
export interface HealthResponse {
  status: "ok";
  service: "peragus-backend";
  version: string;
  timestamp: string;
  uptimeSeconds: number;
}
export interface CreateSettlementRequest {
  request_id: string;
  corridor_id: string;
  payer_wallet: string;
  recipient_wallet: string;
  source_amount: string;
  destination_amount: string;
  expires_at: string;
}
export interface Onramp {
  settlement_id: string;
  settlement_status: SettlementStatus;
  stage: "queued" | "quote_created" | "transfer_created" | "ready";
  ready: boolean;
  quote_id: string | null;
  transfer_id: string | null;
  source_amount_brl: string | null;
  quoted_target_amount_usdt: string | null;
  pix: {
    expires_at: string;
    expired: boolean;
  } | null;
}
export type PublicOnramp = Onramp;
export interface SandboxPaymentAcceptance {
  settlement_id: string;
  settlement_status: SettlementStatus;
  accepted: true;
  reconciliation_scheduled: boolean;
}
export interface PreparedSettlement {
  settlement_id: string;
  settlement_pda: string;
  corridor_pda: string;
  config_pda: string;
  transaction_base64: string;
  message_hash: string;
  fee_payer: string;
  required_external_signer: string;
  recent_blockhash: string;
  last_valid_block_height: number;
}
export interface PreparedRollbackDemo extends PreparedSettlement {
  scenario: "second_leg_insufficient_liquidity";
  injected_destination_amount: string;
  available_destination_balance: string;
  token_accounts: {
    payer_source: string;
    liquidity_source: string;
    liquidity_destination: string;
    recipient_destination: string;
  };
}
export interface ConfirmedSettlement {
  settlement_id: string;
  settlement_pda: string;
  signature: string;
  slot: number;
  status: SettlementStatus;
  version: number;
}
export interface Offramp {
  settlement_id: string;
  settlement_status: SettlementStatus;
  payout_destination_id: string;
  quote_id: string;
  transfer_id: string;
  provider_status: string;
  amounts: { source: Money; quoted_target: Money; transfer_target: Money };
}
export interface AuditEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  content_hash: string;
  provider_status: string;
  source_leg_status: string | null;
  destination_leg_status: string | null;
  amounts: { source: Money; target: Money };
}
export interface SettlementAudit {
  generated_at: string;
  settlement: {
    id: string;
    request_id: string;
    corridor_id: string;
    status: SettlementStatus;
    version: number;
    source_amount_base_units: string;
    destination_amount_base_units: string;
    expires_at: string;
    created_at: string;
    updated_at: string;
  };
  onramp: {
    transfer_id: string | null;
    quote_id: string | null;
    provider_status: string | null;
    source_leg_status: string | null;
    destination_leg_status: string | null;
    source_amount_brl: string | null;
    target_amount_usdt: string | null;
    pix_expires_at: string | null;
    created_at: string | null;
    updated_at: string | null;
    identity_consistent: boolean;
    event_count: number;
    events: AuditEvent[];
  } | null;
  contingency_reserve: {
    status: "funded" | "settled" | "refunded";
    reserve_pda: string;
    vault_pda: string;
    amount_usdt: string;
    amount_base_units: string;
    fallback_after: string;
    expires_at: string;
    create_signature: string;
    resolution_action: "pending" | "settled" | "refunded";
    resolution_signature: string | null;
    version: number;
    created_at: string;
    updated_at: string;
  } | null;
  solana_settlement: {
    settlement_pda: string | null;
    create_signature: string | null;
    execute_signature: string | null;
    atomic_signature: string | null;
    verified: boolean;
  } | null;
  offramp: {
    transfer_id: string | null;
    quote_id: string | null;
    payout_destination_id: string;
    provider_status: string | null;
    source_leg_status: string | null;
    destination_leg_status: string | null;
    source_amount_usdt: string;
    quoted_target_amount_brl: string | null;
    transfer_target_amount_brl: string | null;
    created_at: string;
    updated_at: string;
    identity_consistent: boolean;
    event_count: number;
    events: AuditEvent[];
  } | null;
  checks: {
    onramp_completed: boolean;
    reserve_resolved: boolean;
    solana_transaction_recorded: boolean;
    offramp_completed: boolean;
    settlement_paid_out: boolean;
    evidence_complete: boolean;
  };
  warnings: string[];
}

export interface ApiResult<T, M = Record<string, unknown>> {
  httpStatus: number;
  data: T;
  meta: M | undefined;
}

/** Neutral copy for known codes. Raw backend messages may name providers, so they stay out of the UI. */
const NEUTRAL_MESSAGES: Record<string, string> = {
  IDEMPOTENCY_CONFLICT:
    "This request ID was already used with different details. Start a new instruction.",
  SETTLEMENT_EXPIRED: "The settlement window has expired.",
  SETTLEMENT_NOT_FOUND: "No settlement exists with that ID.",
  SETTLEMENT_NOT_TOKENIZED: "The settlement is not ready for Solana execution yet.",
  SANDBOX_DEMO_DISABLED: "Sandbox checkout controls are not enabled on this backend.",
  SANDBOX_PAYMENT_NOT_READY: "Wait until the Pix sandbox instructions are ready.",
  SANDBOX_PAYMENT_UNAVAILABLE: "The sandbox payment could not be confirmed. It is safe to retry.",
  DEMO_WALLET_FUNDING_FAILED:
    "The Devnet demo wallet could not be prepared. It is safe to retry with the same instruction.",
  ROLLBACK_DEMO_UNAVAILABLE: "The atomic rollback proof is unavailable for this settlement.",
  SOLANA_COSIGNING_DISABLED: "Solana co-signing is not enabled on this backend.",
  SOLANA_CONFIRMATION_DISABLED: "Solana confirmation is not enabled on this backend.",
  SOLANA_SETTLEMENT_NOT_PREPARED: "Prepare the Solana transaction before confirming it.",
  SOLANA_TRANSACTION_NOT_CONFIRMED:
    "The backend cannot see this transaction as confirmed yet. Retry confirmation shortly.",
  SOLANA_TRANSACTION_MISMATCH: "The submitted transaction does not match the prepared settlement.",
  SETTLEMENT_CONCURRENCY_CONFLICT: "The settlement changed during this request. Refresh and retry.",
  VALIDATION_ERROR: "Some fields are invalid. Check the highlighted values.",
  NETWORK_UNAVAILABLE: "The Peragus backend is unreachable.",
  REQUEST_TIMEOUT: "The backend did not respond in time. It is safe to retry.",
  INVALID_RESPONSE: "The backend returned an unexpected response.",
};

export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly settlementStatus: SettlementStatus | undefined;
  readonly details: Array<{ path: string; message: string }>;
  constructor(input: {
    code: string;
    httpStatus: number;
    retryable?: boolean | undefined;
    status?: SettlementStatus | undefined;
    details?: Array<{ path: string; message: string }> | undefined;
  }) {
    super(neutralMessage(input.code, input.httpStatus));
    this.name = "ApiError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.retryable = input.retryable ?? (input.httpStatus === 0 || input.httpStatus >= 500);
    this.settlementStatus = input.status;
    this.details = input.details ?? [];
  }
}

export function neutralMessage(code: string, httpStatus: number): string {
  const known = NEUTRAL_MESSAGES[code];
  if (known) return known;
  if (httpStatus === 0 || httpStatus >= 500) return "Liquidity rail temporarily unavailable.";
  return "The request could not be completed.";
}

const PUBLIC_ERROR_CODES = new Set([
  ...Object.keys(NEUTRAL_MESSAGES),
  "AUDIT_STORAGE_UNAVAILABLE",
  "ONRAMP_STORAGE_UNAVAILABLE",
]);

/** Never expose integration-specific or unexpected backend codes in the browser UI. */
export function publicErrorCode(code: string): string {
  return PUBLIC_ERROR_CODES.has(code) ? code : "REQUEST_FAILED";
}

/** Bounded so no request stays pending forever; retries reuse the same request_id / signature. */
export const REQUEST_TIMEOUT_MS = 15000;
export const HEALTH_TIMEOUT_MS = 5000;

/** Provider statuses are shown only when they are plain lifecycle words; anything else is masked. */
const SAFE_STATUS = new Set([
  "queued",
  "pending",
  "processing",
  "in_progress",
  "awaiting_funds",
  "submitted",
  "completed",
  "complete",
  "succeeded",
  "success",
  "settled",
  "paid",
  "paid_out",
  "failed",
  "cancelled",
  "canceled",
  "expired",
  "refunded",
  "reversed",
  "rejected",
]);
export const publicStatus = (value: string | null | undefined) =>
  value && SAFE_STATUS.has(value.toLowerCase()) ? value.toLowerCase() : "—";

/** Combines an optional caller signal with a timer-based timeout (works with fake timers too). */
function withTimeout(parent: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const timeout = { aborted: false };
  const timer = setTimeout(() => {
    timeout.aborted = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, ms);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timeout,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/** Also bounds response-body reads; fetch resolving headers must not cancel the deadline. */
async function whileNotAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function request<T, M = Record<string, unknown>>(
  base: string,
  path: string,
  init: {
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
  } = {},
): Promise<ApiResult<T, M>> {
  const bounded = withTimeout(init.signal, init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: bounded.signal,
    });
    let payload: unknown = null;
    try {
      payload = await whileNotAborted(response.json(), bounded.signal);
    } catch (error) {
      if (bounded.signal.aborted) throw error;
    }
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload["error"]) ? payload["error"] : null;
      throw new ApiError({
        code: typeof error?.["code"] === "string" ? error["code"] : `HTTP_${response.status}`,
        httpStatus: response.status,
        retryable: typeof error?.["retryable"] === "boolean" ? error["retryable"] : undefined,
        status:
          typeof error?.["status"] === "string" ? (error["status"] as SettlementStatus) : undefined,
        details: Array.isArray(error?.["details"])
          ? (error["details"] as Array<{ path: string; message: string }>)
          : undefined,
      });
    }
    if (!isRecord(payload) || !("data" in payload))
      throw new ApiError({ code: "INVALID_RESPONSE", httpStatus: response.status });
    return {
      httpStatus: response.status,
      data: payload["data"] as T,
      meta: payload["meta"] as M | undefined,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (init.signal?.aborted) throw error;
    if (bounded.timeout.aborted)
      throw new ApiError({ code: "REQUEST_TIMEOUT", httpStatus: 0, retryable: true });
    throw new ApiError({ code: "NETWORK_UNAVAILABLE", httpStatus: 0, retryable: true });
  } finally {
    bounded.clear();
  }
}

export async function getHealth(base: string, signal?: AbortSignal): Promise<HealthResponse> {
  const bounded = withTimeout(signal, HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/health`, {
      headers: { Accept: "application/json" },
      signal: bounded.signal,
    });
    const body: unknown = await whileNotAborted(
      response.json().catch(() => null),
      bounded.signal,
    );
    if (
      !response.ok ||
      !isRecord(body) ||
      body["status"] !== "ok" ||
      body["service"] !== "peragus-backend"
    )
      throw new ApiError({ code: "INVALID_RESPONSE", httpStatus: response.status });
    return body as unknown as HealthResponse;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw error;
    if (bounded.timeout.aborted)
      throw new ApiError({ code: "REQUEST_TIMEOUT", httpStatus: 0, retryable: true });
    throw new ApiError({ code: "NETWORK_UNAVAILABLE", httpStatus: 0 });
  } finally {
    bounded.clear();
  }
}

export const createSettlement = (base: string, body: CreateSettlementRequest) =>
  request<Settlement, { idempotent_replay: boolean }>(base, "/v1/settlements", {
    method: "POST",
    body,
    timeoutMs: 30_000,
  });

export const getSettlement = (base: string, id: string, signal?: AbortSignal) =>
  request<Settlement>(base, `/v1/settlements/${encodeURIComponent(id)}`, { signal });

export async function getOnramp(base: string, id: string, signal?: AbortSignal) {
  const result = await request<
    Onramp & {
      pix:
        | (Onramp["pix"] & {
            intent_id?: string;
            br_code?: string;
            qr_code_image?: string | null;
          })
        | null;
    }
  >(base, `/v1/settlements/${encodeURIComponent(id)}/onramp`, { signal });
  const pix = result.data.pix;
  const data: Onramp = {
    ...result.data,
    pix: pix
      ? {
          expires_at: pix.expires_at,
          expired: pix.expired,
        }
      : null,
  };
  return { ...result, data };
}

export const simulateSandboxPixPayment = (base: string, id: string) =>
  request<SandboxPaymentAcceptance, { idempotent_replay: boolean; environment: "sandbox" }>(
    base,
    `/v1/settlements/${encodeURIComponent(id)}/onramp/simulate-payment`,
    { method: "POST" },
  );

export const prepareSettlement = (base: string, id: string) =>
  request<
    PreparedSettlement,
    { idempotent_replay: boolean; transaction_format: string; broadcast_by: string }
  >(base, `/v1/settlements/${encodeURIComponent(id)}/solana/prepare`, { method: "POST" });

export const prepareRollbackDemo = (base: string, id: string) =>
  request<
    PreparedRollbackDemo,
    {
      environment: "sandbox";
      network: "devnet";
      expected_result: "transaction_failure";
    }
  >(base, `/v1/settlements/${encodeURIComponent(id)}/solana/rollback-demo/prepare`, {
    method: "POST",
  });

export const confirmSettlement = (base: string, id: string, signature: string) =>
  request<ConfirmedSettlement, { idempotent_replay: boolean; verified_on_chain: true }>(
    base,
    `/v1/settlements/${encodeURIComponent(id)}/solana/confirm`,
    { method: "POST", body: { signature } },
  );

export const initiateOfframp = (base: string, id: string, payoutDestinationId: string) =>
  request<Offramp, { idempotent_replay: boolean; environment: string }>(
    base,
    `/v1/settlements/${encodeURIComponent(id)}/offramp`,
    { method: "POST", body: { payout_destination_id: payoutDestinationId } },
  );

export const getAudit = (base: string, id: string, signal?: AbortSignal) =>
  request<SettlementAudit>(base, `/v1/settlements/${encodeURIComponent(id)}/audit`, { signal });

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const U64_PATTERN = /^[1-9][0-9]{0,19}$/;
export const CORRIDOR_PATTERN = /^[0-9a-fA-F]{64}$/;
export const isPositiveU64 = (value: string) =>
  U64_PATTERN.test(value) && BigInt(value) <= 18446744073709551615n;
