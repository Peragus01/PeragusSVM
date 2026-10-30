export interface Quote {
  id: string;
  request_id: string;
  state: "quoted";
  source: { currency: "BRL"; amount: string };
  target: { currency: "USDT"; amount: string; chain: "solana" };
  rate: string;
  exchange_conditions?: { amount_deducted: string | null; spread_bps?: number };
  expires_at: string | null;
  environment: "test";
  indicative: true;
  executable: false;
  operations_enabled: false;
  external_delivery_costs_evaluated: false;
}
export interface PurchaseRecord {
  destination?: { wallet_address: string; proof_network: "solana:devnet" };
  id: string;
  request_id: string;
  quote_id: string;
  source: Quote["source"];
  estimated_target: Quote["target"];
  state: "recorded";
  environment: "test";
  record_only: true;
  funding_started: false;
  job_enqueued: false;
  operations_enabled: false;
  executable: false;
}
export interface PurchasePlan {
  customerId: string;
  amount: string;
  quoteRequestId: string;
  purchaseRequestId: string;
  quoteAttempted: boolean;
  purchaseAttempted: boolean;
  quoteId?: string;
  purchaseId?: string;
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const decimal = (v: unknown): v is string =>
  typeof v === "string" && /^\d{1,12}(?:\.\d{1,8})?$/.test(v) && /[1-9]/.test(v);
export class PurchaseError extends Error {
  constructor(
    public readonly code: string,
    public readonly quoteId?: string,
  ) {
    super(code);
  }
}
export function normalizePurchaseAmount(input: string): string | null {
  const text = input.trim().replace(",", ".");
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")) < 100000n) return null;
  return `${whole}.${fraction.padEnd(2, "0")}`;
}
export function readPurchasePlan(customerId: string): PurchasePlan | null {
  const text = sessionStorage.getItem(`peragus-purchase-v1:${customerId}`);
  if (!text) return null;
  const d: unknown = JSON.parse(text);
  if (
    !record(d) ||
    d["customerId"] !== customerId ||
    typeof d["amount"] !== "string" ||
    normalizePurchaseAmount(d["amount"]) !== d["amount"] ||
    !uuid(d["quoteRequestId"]) ||
    !uuid(d["purchaseRequestId"]) ||
    typeof d["quoteAttempted"] !== "boolean" ||
    typeof d["purchaseAttempted"] !== "boolean" ||
    (d["quoteId"] !== undefined && !uuid(d["quoteId"])) ||
    (d["purchaseId"] !== undefined && !uuid(d["purchaseId"]))
  )
    throw new PurchaseError("LOCAL_PLAN_INVALID");
  return d as unknown as PurchasePlan;
}
export function savePurchasePlan(plan: PurchasePlan) {
  // Persist request IDs before a POST; never persist auth tokens or provider payloads.
  sessionStorage.setItem(`peragus-purchase-v1:${plan.customerId}`, JSON.stringify(plan));
}
export async function purchaseRequest(
  token: string,
  path: string,
  body?: object,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!token || !/^[A-Za-z0-9._-]+$/.test(token)) throw new PurchaseError("AUTH_REQUIRED");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 30000);
  try {
    const response = await fetch(`/api/v1/me/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json: unknown = await response.json();
    if (!response.ok) {
      const e = record(json) && record(json["error"]) ? json["error"] : null;
      const code =
        typeof e?.["code"] === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(e["code"])
          ? e["code"]
          : "PURCHASE_UNAVAILABLE";
      throw new PurchaseError(code, uuid(e?.["quote_id"]) ? e["quote_id"] : undefined);
    }
    if (!record(json)) throw new PurchaseError("INVALID_RESPONSE");
    return json["data"];
  } catch (e) {
    if (e instanceof PurchaseError) throw e;
    throw new PurchaseError("OUTCOME_UNKNOWN");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export function validateQuote(value: unknown, plan: PurchasePlan): Quote {
  if (
    !record(value) ||
    !uuid(value["id"]) ||
    value["request_id"] !== plan.quoteRequestId ||
    (plan.quoteId && value["id"] !== plan.quoteId) ||
    value["state"] !== "quoted" ||
    value["environment"] !== "test" ||
    value["indicative"] !== true ||
    value["executable"] !== false ||
    value["operations_enabled"] !== false ||
    value["external_delivery_costs_evaluated"] !== false ||
    !record(value["source"]) ||
    value["source"]["currency"] !== "BRL" ||
    value["source"]["amount"] !== plan.amount ||
    !record(value["target"]) ||
    value["target"]["currency"] !== "USDT" ||
    value["target"]["chain"] !== "solana" ||
    !decimal(value["target"]["amount"]) ||
    !decimal(value["rate"]) ||
    (value["exchange_conditions"] !== undefined &&
      value["exchange_conditions"] !== null &&
      (!record(value["exchange_conditions"]) ||
        (value["exchange_conditions"]["spread_bps"] !== undefined &&
          value["exchange_conditions"]["spread_bps"] !== 0) ||
        !(
          value["exchange_conditions"]["amount_deducted"] === null ||
          (typeof value["exchange_conditions"]["amount_deducted"] === "string" &&
            /^\d{1,12}(?:\.\d{1,8})?$/.test(value["exchange_conditions"]["amount_deducted"]))
        ))) ||
    !(
      value["expires_at"] === null ||
      (typeof value["expires_at"] === "string" && Number.isFinite(Date.parse(value["expires_at"])))
    )
  )
    throw new PurchaseError("QUOTE_EVIDENCE_INVALID");
  return value as unknown as Quote;
}
export function validatePurchase(value: unknown, plan: PurchasePlan, quote: Quote): PurchaseRecord {
  if (
    !record(value) ||
    !uuid(value["id"]) ||
    value["request_id"] !== plan.purchaseRequestId ||
    (plan.purchaseId && value["id"] !== plan.purchaseId) ||
    value["quote_id"] !== quote.id ||
    value["environment"] !== "test" ||
    value["state"] !== "recorded" ||
    (value["destination"] !== undefined &&
      (!record(value["destination"]) ||
        value["destination"]["proof_network"] !== "solana:devnet" ||
        typeof value["destination"]["wallet_address"] !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value["destination"]["wallet_address"]))) ||
    value["record_only"] !== true ||
    value["funding_started"] !== false ||
    value["job_enqueued"] !== false ||
    value["operations_enabled"] !== false ||
    value["executable"] !== false ||
    !record(value["source"]) ||
    value["source"]["amount"] !== plan.amount ||
    value["source"]["currency"] !== "BRL" ||
    !record(value["estimated_target"]) ||
    value["estimated_target"]["amount"] !== quote.target.amount ||
    value["estimated_target"]["currency"] !== "USDT" ||
    value["estimated_target"]["chain"] !== "solana"
  )
    throw new PurchaseError("PURCHASE_EVIDENCE_INVALID");
  return value as unknown as PurchaseRecord;
}
