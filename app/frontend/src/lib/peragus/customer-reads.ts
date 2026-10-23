/** Customer session tokens come from the login layer; this module stores no session. */
export interface CustomerOperation {
  id: string;
  quote_id: string;
  created_at: string;
  environment: "test";
  real_money: false;
  stage: "purchase_recorded" | "pix" | "withdrawal";
  source: { currency: "BRL"; amount: string };
  estimated_target: { currency: "USDT"; amount: string; indicative: true };
  converted_target: { currency: "USDT"; amount: string } | null;
  destination: { wallet_address: string; network: "solana"; proof_network: "solana:devnet" };
  pix: { id: string; state: string; conversion_completed: boolean } | null;
  withdrawal: {
    id: string;
    approved: boolean;
    state: string;
    withdrawal_started: boolean;
    provider_completed: boolean;
    recovery_required: boolean;
    result_path: string;
  } | null;
  observation_freshness: "not_evaluated";
  onchain_delivery_verified: false;
  mainnet_execution: false;
}

export interface CustomerOperationsPage {
  data: CustomerOperation[];
  meta: { has_more: boolean; next_cursor: string | null };
}

export interface CustomerWithdrawalResult {
  withdrawal_request_id: string;
  environment: "test";
  real_money: false;
  state: string;
  approved: boolean;
  withdrawal_started: boolean;
  provider_completed: boolean;
  recovery_required: boolean;
  amounts: {
    currency: "USDT";
    gross_amount: string;
    net_amount: string | null;
    deducted_amount: string | null;
    basis: "recorded_provider_amounts" | "not_reported";
    fee_breakdown: null;
  };
  destination: CustomerOperation["destination"];
  observed_at: string | null;
  observation_freshness: "not_evaluated";
  onchain_delivery_verified: false;
  mainnet_execution: false;
}

export class CustomerReadError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super("Não foi possível consultar os dados da operação.");
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sandbox = (value: Record<string, unknown>) =>
  value["environment"] === "test" &&
  value["real_money"] === false &&
  value["onchain_delivery_verified"] === false &&
  value["mainnet_execution"] === false;

async function read(path: string, token: string, signal?: AbortSignal): Promise<unknown> {
  if (!token || token.length > 8185 || !/^[A-Za-z0-9._-]+$/.test(token))
    throw new CustomerReadError("AUTH_REQUIRED", 401);
  try {
    const response = await fetch(`/api${path}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = record(body) && record(body["error"]) ? body["error"] : null;
      const code =
        typeof error?.["code"] === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error["code"])
          ? error["code"]
          : "CUSTOMER_READ_UNAVAILABLE";
      throw new CustomerReadError(code, response.status);
    }
    return body;
  } catch (error) {
    if (error instanceof CustomerReadError || signal?.aborted) throw error;
    throw new CustomerReadError("CUSTOMER_READ_UNAVAILABLE", 0);
  }
}

export async function getCustomerOperations(
  accessToken: string,
  options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
): Promise<CustomerOperationsPage> {
  const limit = options.limit ?? 20;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (options.cursor !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor))
  )
    throw new CustomerReadError("VALIDATION_ERROR", 400);
  const query = new URLSearchParams({ limit: String(limit) });
  if (options.cursor) query.set("cursor", options.cursor);
  const body = await read(`/v1/me/operations?${query}`, accessToken, options.signal);
  if (
    !record(body) ||
    !Array.isArray(body["data"]) ||
    body["data"].length > limit ||
    !record(body["meta"]) ||
    typeof body["meta"]["has_more"] !== "boolean" ||
    !(body["meta"]["next_cursor"] === null || typeof body["meta"]["next_cursor"] === "string") ||
    (body["meta"]["has_more"] && !body["meta"]["next_cursor"]) ||
    (!body["meta"]["has_more"] && body["meta"]["next_cursor"] !== null) ||
    !body["data"].every(
      (item) =>
        record(item) && typeof item["id"] === "string" && uuid.test(item["id"]) && sandbox(item),
    )
  )
    throw new CustomerReadError("INVALID_RESPONSE", 200);
  return body as unknown as CustomerOperationsPage;
}

export async function getCustomerWithdrawalResult(
  accessToken: string,
  withdrawalId: string,
  signal?: AbortSignal,
): Promise<CustomerWithdrawalResult> {
  if (!uuid.test(withdrawalId)) throw new CustomerReadError("VALIDATION_ERROR", 400);
  const body = await read(`/v1/me/withdrawal-requests/${withdrawalId}/result`, accessToken, signal);
  if (
    !record(body) ||
    !record(body["data"]) ||
    !sandbox(body["data"]) ||
    body["data"]["withdrawal_request_id"] !== withdrawalId ||
    !record(body["data"]["amounts"]) ||
    typeof body["data"]["amounts"]["gross_amount"] !== "string" ||
    ![body["data"]["amounts"]["net_amount"], body["data"]["amounts"]["deducted_amount"]].every(
      (value) => value === null || typeof value === "string",
    )
  )
    throw new CustomerReadError("INVALID_RESPONSE", 200);
  return body["data"] as unknown as CustomerWithdrawalResult;
}
