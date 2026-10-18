import https from "node:https";

export interface OzavResponse {
  statusCode: number;
  body: unknown;
  headers?: Readonly<Record<string, string | undefined>>;
}

export type OzavTransport = (
  path: string,
  apiKey: string,
  timeoutMs: number,
) => Promise<OzavResponse>;

export interface OzavWriteRequest {
  path: string;
  body: Readonly<Record<string, unknown>>;
  idempotencyKey?: string;
}

export type OzavWriteTransport = (
  request: OzavWriteRequest,
  apiKey: string,
  timeoutMs: number,
) => Promise<OzavResponse>;

export class OzavClientError extends Error {
  readonly statusCode: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, statusCode?: number) {
    super(message);
    this.name = "OzavClientError";
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

export interface OzavSandboxCustomerInput {
  externalRef: string;
  email: string;
  legalName: string;
  taxId: string;
}
export interface OzavSandboxCustomer {
  id: string;
  externalRef: string;
  email: string;
  status: string;
  verificationMode: "full" | "reliance" | null;
}

export interface OzavTermsSession {
  token: string | null; status: "pending" | "accepted"; url: string; version: string; expiresAt: string; acceptedAt: string | null;
}
export interface OzavTermsEvidence { accepted_by: { legal_name: string }; accepted_at: string; }
function parseTermsSession(value: unknown): OzavTermsSession {
  const row = object(value);
  if (row.object !== "terms_session" || (row.status !== "pending" && row.status !== "accepted")) return invalidResponse();
  const url = new URL(text(row.terms_url));
  if (url.origin !== "https://ozav.io" || url.username || url.password || url.search || url.hash || url.pathname.includes("ts_")) return invalidResponse();
  const version = text(row.terms_version);
  if (!version || version.length > 80) return invalidResponse();
  const date = (value: unknown): string => {
    const raw = text(value);
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) return invalidResponse();
    return new Date(raw).toISOString();
  };
  const token = row.id == null ? null : text(row.id);
  if (token !== null && !/^ts_[A-Za-z0-9_-]{8,256}$/.test(token)) return invalidResponse();
  return { token, status: row.status, url: url.toString(), version, expiresAt: date(row.expires_at), acceptedAt: row.accepted_at == null ? null : date(row.accepted_at) };
}

export interface OzavCustomerSnapshot {
  provider_status: string;
  verification_mode: "full" | "reliance" | null;
  verification_status: string | null;
  due_codes: string[] | null;
  due_count: number | null;
  missing_fields_count: number | null;
  documents_due_count: number | null;
  requirements_pending: boolean | null;
}

export interface OzavTransfer {
  id: string;
  status: string;
  customerId: string;
  quoteId: string | null;
  source: {
    type: string;
    currency: string | null;
    rail: string | null;
    walletId?: string | null;
    paymentInstructions?: OzavPaymentInstructions | null;
  };
  destination: {
    type: string;
    walletId: string | null;
    payoutDestinationId?: string | null;
  };
  sourceLegStatus: string | null;
  destinationLegStatus: string | null;
  amounts: {
    source: { amount: string; currency: string };
    target: { amount: string; currency: string };
  };
}

export interface OzavPaymentInstructions {
  intentId: string;
  brCode: string;
  qrCodeImage: string | null;
  expiresAt: string;
}

export interface OzavQuote {
  id: string;
  customerId: string;
  rateType: "floating" | "locked";
  rate: string;
  source: { amount: string; currency: string };
  target: { amount: string; currency: string };
  spreadBps: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateOzavQuoteInput {
  customerId: string;
  sourceAmountBrl: string;
  spreadBps: number;
}

export interface CreateOzavTransferInput {
  customerId: string;
  walletId: string;
  quoteId: string;
  idempotencyKey: string;
  metadata: Readonly<Record<string, string>>;
}

export interface OzavPayoutDestination {
  id: string;
  customerId: string;
  currency: string;
  rail: string;
  status: "active" | "inactive";
}

export interface CreateOzavOfframpQuoteInput {
  customerId: string;
  sourceAmountUsdt: string;
  spreadBps: number;
}

export interface CreateOzavOfframpTransferInput {
  customerId: string;
  walletId: string;
  payoutDestinationId: string;
  quoteId: string;
  idempotencyKey: string;
  metadata: Readonly<Record<string, string>>;
}

export interface OzavEvent {
  id: string;
  type: string;
  createdAt: string;
  transfer: OzavTransfer | null;
}

export interface OzavEventPage {
  data: OzavEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

function invalidResponse(): never {
  throw new OzavClientError("Invalid OZAV response", false);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidResponse();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.length) return invalidResponse();
  return value;
}

function optionalText(value: unknown): string | null {
  return value == null ? null : text(value);
}

function identifier(value: unknown, prefix: string): string {
  const result = text(value);
  if (!result.startsWith(prefix) || result.length === prefix.length
    || !/^[a-zA-Z0-9_]+$/.test(result)) {
    return invalidResponse();
  }
  return result;
}

function amount(value: unknown): { amount: string; currency: string } {
  const row = object(value);
  const decimal = text(row.amount);
  if (!/^\d+(?:\.\d{1,6})?$/.test(decimal)) return invalidResponse();
  return { amount: decimal, currency: text(row.currency) };
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (Number.isNaN(Date.parse(result))) return invalidResponse();
  return result;
}

function paymentInstructions(value: unknown): OzavPaymentInstructions | null {
  if (value == null) return null;
  const row = object(value);
  if (row.rail !== "pix") return invalidResponse();
  return {
    intentId: text(row.intent_id),
    brCode: text(row.br_code),
    qrCodeImage: optionalText(row.qr_code_image),
    expiresAt: timestamp(row.expires_at),
  };
}

function quote(value: unknown): OzavQuote {
  const row = object(value);
  if (row.object !== "quote") return invalidResponse();
  const rateType = text(row.rate_type);
  if (rateType !== "floating" && rateType !== "locked") {
    return invalidResponse();
  }
  const exchangeConditions = object(row.exchange_conditions);
  const spreadBps = exchangeConditions.spread_bps;
  if (typeof spreadBps !== "number"
    || !Number.isInteger(spreadBps)
    || spreadBps < 0
    || spreadBps > 10_000) {
    return invalidResponse();
  }
  const result: OzavQuote = {
    id: identifier(row.id, "ozav_q_"),
    customerId: identifier(row.customer_id, "ozav_cus_"),
    rateType,
    rate: text(row.rate),
    source: amount(row.source),
    target: amount(row.target),
    spreadBps,
    expiresAt: row.expires_at == null ? null : timestamp(row.expires_at),
    createdAt: timestamp(row.created_at),
  };
  if (!/^\d+(?:\.\d{1,12})?$/.test(result.rate)) return invalidResponse();
  return result;
}

function payoutDestination(
  value: unknown,
): OzavPayoutDestination {
  const row = object(value);
  if (row.object !== "payout_destination") {
    return invalidResponse();
  }

  const status = text(row.status);
  if (status !== "active" && status !== "inactive") {
    return invalidResponse();
  }

  return {
    id: identifier(row.id, "ozav_pd_"),
    customerId: identifier(
      row.customer_id,
      "ozav_cus_",
    ),
    currency: text(row.currency),
    rail: text(row.rail),
    status,
  };
}

function transfer(value: unknown): OzavTransfer {
  const row = object(value);
  if (row.object !== "transfer") return invalidResponse();
  const source = object(row.source);
  const destination = object(row.destination);
  const amounts = object(row.amounts);
  const sourceWalletId = source.wallet_id == null
    ? null
    : identifier(source.wallet_id, "ozav_wal_");
  const payoutDestinationId =
    destination.payout_destination_id == null
      ? null
      : identifier(
          destination.payout_destination_id,
          "ozav_pd_",
        );

  return {
    id: identifier(row.id, "ozav_tr_"),
    status: text(row.status),
    customerId: identifier(row.customer_id, "ozav_cus_"),
    quoteId: row.quote_id == null ? null : identifier(row.quote_id, "ozav_q_"),
    source: {
      type: text(source.type),
      currency: optionalText(source.currency),
      rail: optionalText(source.rail),
      walletId: sourceWalletId,
      paymentInstructions: paymentInstructions(source.payment_instructions),
    },
    destination: {
      type: text(destination.type),
      walletId: destination.wallet_id == null
        ? null : identifier(destination.wallet_id, "ozav_wal_"),
      payoutDestinationId,
    },
    sourceLegStatus: row.source_leg == null
      ? null : optionalText(object(row.source_leg).status),
    destinationLegStatus: row.destination_leg == null
      ? null : optionalText(object(row.destination_leg).status),
    amounts: { source: amount(amounts.source), target: amount(amounts.target) },
  };
}

export const httpsOzavTransport: OzavTransport = (path, apiKey, timeoutMs) =>
  new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "developers.ozav.io",
      port: 443,
      path,
      method: "GET",
      family: 4,
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          request.destroy(new OzavClientError("OZAV response too large", false));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => {
        request.destroy(new OzavClientError("OZAV response interrupted", true));
      });
      response.on("end", () => {
        clearTimeout(deadline);
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          resolve({ statusCode, body: null });
          return;
        }
        try {
          resolve({ statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          reject(new OzavClientError("Invalid OZAV JSON response", false));
        }
      });
    });
    const deadline = setTimeout(() => {
      request.destroy(new OzavClientError("OZAV connection timeout", true));
    }, timeoutMs);
    request.on("error", (error: Error) => {
      clearTimeout(deadline);
      reject(error instanceof OzavClientError
        ? error : new OzavClientError("OZAV connection failed", true));
    });
    request.end();
  });

export const httpsOzavWriteTransport: OzavWriteTransport = (
  input,
  apiKey,
  timeoutMs,
) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(input.body);
  const headers: Record<string, string | number> = {
    "X-API-Key": apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  };
  if (input.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = input.idempotencyKey;
  }
  const request = https.request({
    hostname: "developers.ozav.io",
    port: 443,
    path: input.path,
    method: "POST",
    family: 4,
    headers,
  }, (response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        request.destroy(
          new OzavClientError("OZAV response too large", false),
        );
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", () => {
      request.destroy(
        new OzavClientError("OZAV response interrupted", true),
      );
    });
    response.on("end", () => {
      clearTimeout(deadline);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw.length) {
        try {
          body = JSON.parse(raw);
        } catch {
          reject(
            new OzavClientError(
              "Invalid OZAV JSON response",
              false,
            ),
          );
          return;
        }
      }
      const replayed = response.headers["idempotent-replayed"];
      resolve({
        statusCode: response.statusCode ?? 0,
        body,
        headers: {
          "idempotent-replayed":
            typeof replayed === "string" ? replayed : undefined,
        },
      });
    });
  });
  const deadline = setTimeout(() => {
    request.destroy(
      new OzavClientError("OZAV connection timeout", true),
    );
  }, timeoutMs);
  request.on("error", (error: Error) => {
    clearTimeout(deadline);
    reject(
      error instanceof OzavClientError
        ? error
        : new OzavClientError("OZAV connection failed", true),
    );
  });
  request.end(payload);
});

export interface OzavClientOptions {
  apiKey: string;
  transport?: OzavTransport;
  writeTransport?: OzavWriteTransport;
  timeoutMs?: number;
  attempts?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

/** Sandbox-only OZAV client. State changes require explicit method calls. */
export class OzavClient {
  private readonly apiKey: string;
  private readonly transport: OzavTransport;
  private readonly writeTransport: OzavWriteTransport;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(options: OzavClientOptions) {
    if (!/^ozav_sk_test_[A-Za-z0-9_-]+$/.test(options.apiKey)) {
      throw new OzavClientError("A sandbox OZAV key is required", false);
    }
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? httpsOzavTransport;
    this.writeTransport =
      options.writeTransport ?? httpsOzavWriteTransport;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.attempts = options.attempts ?? 3;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000
      || !Number.isInteger(this.attempts) || this.attempts < 1 || this.attempts > 3) {
      throw new OzavClientError("Invalid OZAV timeout or attempts", false);
    }
  }

  private async get(path: string): Promise<unknown> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        const result = await this.transport(path, this.apiKey, this.timeoutMs);
        if (result.statusCode < 200 || result.statusCode >= 300) {
          throw new OzavClientError(`OZAV HTTP ${result.statusCode}`,
            [408, 429].includes(result.statusCode) || result.statusCode >= 500,
            result.statusCode);
        }
        return result.body;
      } catch (error) {
        const safeError = error instanceof OzavClientError
          ? error : new OzavClientError("OZAV connection failed", true);
        if (!safeError.retryable || attempt === this.attempts) throw safeError;
        await this.wait(1_000 * attempt);
      }
    }
    throw new OzavClientError("OZAV request failed", true);
  }

  private async post(
    request: OzavWriteRequest,
    acceptProcessing = false,
  ): Promise<OzavResponse> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        const result = await this.writeTransport(
          request,
          this.apiKey,
          this.timeoutMs,
        );
        if (
          result.statusCode === 202
          && !acceptProcessing
        ) {
          throw new OzavClientError(
            "OZAV HTTP 202",
            true,
            result.statusCode,
          );
        }
        if (result.statusCode < 200 || result.statusCode >= 300) {
          throw new OzavClientError(
            `OZAV HTTP ${result.statusCode}`,
            [408, 429].includes(result.statusCode)
              || result.statusCode >= 500,
            result.statusCode,
          );
        }
        return result;
      } catch (error) {
        const safeError = error instanceof OzavClientError
          ? error
          : new OzavClientError("OZAV connection failed", true);
        if (!safeError.retryable || attempt === this.attempts) {
          throw safeError;
        }
        await this.wait(1_000 * attempt);
      }
    }
    throw new OzavClientError("OZAV request failed", true);
  }

  async getCapabilities(): Promise<{ environment: "test"; scopes: string[] }> {
    const row = object(await this.get("/v2/capabilities"));
    if (row.environment !== "test" || !Array.isArray(row.scopes)) {
      return invalidResponse();
    }
    return { environment: "test", scopes: row.scopes.map(text) };
  }

  async getCustomerCapabilities(): Promise<{ environment: "test"; entitlements: string[]; scopes: string[] }> {
    const row = object(await this.get("/v2/capabilities"));
    if (row.environment !== "test" || !Array.isArray(row.entitlements) || !Array.isArray(row.scopes)) return invalidResponse();
    return { environment: "test", entitlements: row.entitlements.map(text), scopes: row.scopes.map(text) };
  }

  async createSandboxCustomer(input: OzavSandboxCustomerInput, idempotencyKey: string): Promise<OzavSandboxCustomer> {
    if (!/^peragus-sandbox:[0-9a-f-]{36}$/.test(input.externalRef)
      || !/^peragus-customer-test-[0-9a-f-]{36}$/.test(idempotencyKey)
      || !/^[0-9]{11}$/.test(input.taxId)
      || !/^peragus-sandbox-[0-9a-f-]{36}@example.com$/.test(input.email)
      || input.legalName !== "Teste Peragus Sandbox") {
      throw new OzavClientError("Only generated sandbox customer fixtures are allowed", false);
    }
    const response = await this.post({
      path: "/v2/customers", idempotencyKey,
      body: {
        type: "individual", external_ref: input.externalRef, email: input.email,
        individual: { legal_name: input.legalName, tax_id: { country: "BR", type: "cpf", value: input.taxId } },
        verification_mode: "full", custody_model: "managed", monitoring: false,
        metadata: { peragus_sandbox_fixture: "true" },
      },
    });
    const row = object(response.body);
    if (row.object !== "customer" || row.type !== "individual") return invalidResponse();
    const verification = row.verification == null ? null : object(row.verification);
    const mode = verification?.mode ?? null;
    if (mode !== null && mode !== "full" && mode !== "reliance") return invalidResponse();
    const result: OzavSandboxCustomer = { id: identifier(row.id, "ozav_cus_"), externalRef: text(row.external_ref),
      email: text(row.email), status: text(row.status), verificationMode: mode };
    if (result.externalRef !== input.externalRef || result.email !== input.email || result.verificationMode === "reliance") return invalidResponse();
    return result;
  }

  async getSandboxCustomerSnapshot(id: string, externalRef: string): Promise<OzavCustomerSnapshot> {
    identifier(id, "ozav_cus_");
    const row = object(await this.get(`/v2/customers/${encodeURIComponent(id)}`));
    if (row.id !== id || row.object !== "customer" || row.type !== "individual" || row.external_ref !== externalRef) return invalidResponse();
    const code = (value: unknown): string => {
      if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(value)) return invalidResponse();
      return value;
    };
    const verification = row.verification == null ? {} : object(row.verification);
    const mode = verification.mode ?? null;
    if (mode !== null && mode !== "full" && mode !== "reliance") return invalidResponse();
    const requirements = row.requirements == null ? {} : object(row.requirements);
    const count = (value: unknown): number | null => {
      if (value == null) return null;
      if (!Array.isArray(value) || value.length > 1000) return invalidResponse();
      return value.length;
    };
    const dueCount = count(requirements.due), missingCount = count(requirements.missing_fields), documentCount = count(requirements.documents_due);
    const codesCount = count(requirements.due_codes);
    const dueCodes = codesCount === null ? null : (requirements.due_codes as unknown[]).map(code);
    const counts = [dueCount, missingCount, documentCount, codesCount];
    const pending = counts.some(n => n !== null && n > 0) ? true : counts.every(n => n !== null) ? false : null;
    return { provider_status: code(row.status), verification_mode: mode,
      verification_status: verification.status == null ? null : code(verification.status),
      due_codes: dueCodes, due_count: dueCount, missing_fields_count: missingCount,
      documents_due_count: documentCount, requirements_pending: pending };
  }

  async createCustomerTerms(idempotencyKey: string): Promise<OzavTermsSession> {
    if (!/^peragus-terms-[0-9a-f-]{36}$/.test(idempotencyKey)) throw new OzavClientError("Invalid terms request", false);
    return parseTermsSession((await this.post({ path: "/v2/customers/terms-sessions", body: {}, idempotencyKey })).body);
  }
  async acceptCustomerTerms(token: string, evidence: OzavTermsEvidence): Promise<OzavTermsSession> {
    if (!/^ts_[A-Za-z0-9_-]{8,256}$/.test(token)) throw new OzavClientError("Invalid terms session", false);
    return parseTermsSession((await this.post({ path: "/v2/customers/terms-sessions/accept", body: {
      terms_session_id: token, accepted_by: evidence.accepted_by, accepted_at: evidence.accepted_at,
    } })).body);
  }

  async getTransfer(id: string): Promise<OzavTransfer> {
    identifier(id, "ozav_tr_");
    const result = transfer(await this.get(`/v2/transfers/${encodeURIComponent(id)}`));
    if (result.id !== id) return invalidResponse();
    return result;
  }

  async getPayoutDestination(
    id: string,
  ): Promise<OzavPayoutDestination> {
    identifier(id, "ozav_pd_");
    const result = payoutDestination(
      await this.get(
        `/v2/payout-destinations/${encodeURIComponent(id)}`,
      ),
    );
    if (result.id !== id) return invalidResponse();
    return result;
  }

  async listEvents(startingAfter?: string): Promise<OzavEventPage> {
    const query = new URLSearchParams({ limit: "100" });
    if (startingAfter !== undefined) query.set("starting_after", text(startingAfter));
    const row = object(await this.get(`/v2/events?${query}`));
    if (!Array.isArray(row.data) || typeof row.has_more !== "boolean") {
      return invalidResponse();
    }
    const nextCursor = optionalText(row.next_cursor);
    if (row.has_more && !nextCursor) return invalidResponse();
    return {
      data: row.data.map((value): OzavEvent => {
        const event = object(value);
        if (event.object !== "event") return invalidResponse();
        const createdAt = text(event.created_at);
        if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(createdAt)
          || Number.isNaN(Date.parse(createdAt))) return invalidResponse();
        const data = object(event.data);
        return {
          id: identifier(event.id, "ozav_evt_"),
          type: text(event.type),
          createdAt,
          transfer: data.transfer == null ? null : transfer(data.transfer),
        };
      }),
      hasMore: row.has_more,
      nextCursor,
    };
  }

  async createQuote(input: CreateOzavQuoteInput): Promise<OzavQuote> {
    identifier(input.customerId, "ozav_cus_");
    if (!/^\d+(?:\.\d{1,2})?$/.test(input.sourceAmountBrl)
      || !Number.isInteger(input.spreadBps)
      || input.spreadBps < 0
      || input.spreadBps > 10_000) {
      throw new OzavClientError(
        "Invalid OZAV quote input",
        false,
      );
    }
    const response = await this.post({
      path: "/v2/quotes",
      body: {
        customer_id: input.customerId,
        source: {
          currency: "BRL",
          amount: input.sourceAmountBrl,
        },
        target: {
          currency: "USDT",
          chain: "solana",
        },
        source_rail: "pix",
        spread_bps: input.spreadBps,
      },
    });
    return quote(response.body);
  }

  async createTransfer(
    input: CreateOzavTransferInput,
  ): Promise<{
    transfer: OzavTransfer;
    idempotentReplayed: boolean;
  }> {
    identifier(input.customerId, "ozav_cus_");
    identifier(input.walletId, "ozav_wal_");
    identifier(input.quoteId, "ozav_q_");
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(input.idempotencyKey)
      || Object.keys(input.metadata).length > 50
      || Object.values(input.metadata).some(
        (value) => typeof value !== "string",
      )) {
      throw new OzavClientError(
        "Invalid OZAV transfer input",
        false,
      );
    }
    const response = await this.post({
      path: "/v2/transfers",
      idempotencyKey: input.idempotencyKey,
      body: {
        customer_id: input.customerId,
        quote_id: input.quoteId,
        source: {
          type: "fiat_payment",
          currency: "BRL",
          rail: "pix",
        },
        destination: {
          type: "wallet",
          wallet_id: input.walletId,
        },
        metadata: input.metadata,
      },
    });
    return {
      transfer: transfer(response.body),
      idempotentReplayed:
        response.headers?.["idempotent-replayed"] === "true",
    };
  }

  async simulateTransfer(id: string): Promise<void> {
    identifier(id, "ozav_tr_");
    await this.post(
      {
        path:
          `/v2/transfers/${encodeURIComponent(id)}/simulate`,
        body: {},
      },
      true,
    );
  }

  async createOfframpQuote(
    input: CreateOzavOfframpQuoteInput,
  ): Promise<OzavQuote> {
    identifier(input.customerId, "ozav_cus_");
    if (
      !/^\d+(?:\.\d{1,6})?$/.test(
        input.sourceAmountUsdt,
      )
      || !Number.isInteger(input.spreadBps)
      || input.spreadBps < 0
      || input.spreadBps > 10_000
    ) {
      throw new OzavClientError(
        "Invalid OZAV off-ramp quote input",
        false,
      );
    }

    const response = await this.post({
      path: "/v2/quotes",
      body: {
        customer_id: input.customerId,
        source: {
          currency: "USDT",
          amount: input.sourceAmountUsdt,
          chain: "solana",
        },
        target: {
          currency: "BRL",
        },
        destination_rail: "pix",
        spread_bps: input.spreadBps,
      },
    });

    return quote(response.body);
  }

  async createOfframpTransfer(
    input: CreateOzavOfframpTransferInput,
  ): Promise<{
    transfer: OzavTransfer;
    idempotentReplayed: boolean;
  }> {
    identifier(input.customerId, "ozav_cus_");
    identifier(input.walletId, "ozav_wal_");
    identifier(
      input.payoutDestinationId,
      "ozav_pd_",
    );
    identifier(input.quoteId, "ozav_q_");

    if (
      !/^[A-Za-z0-9_-]{16,256}$/.test(
        input.idempotencyKey,
      )
      || Object.keys(input.metadata).length > 50
      || Object.values(input.metadata).some(
        (value) => typeof value !== "string",
      )
    ) {
      throw new OzavClientError(
        "Invalid OZAV off-ramp transfer input",
        false,
      );
    }

    const response = await this.post({
      path: "/v2/transfers",
      idempotencyKey: input.idempotencyKey,
      body: {
        customer_id: input.customerId,
        quote_id: input.quoteId,
        source: {
          type: "wallet",
          wallet_id: input.walletId,
          currency: "USDT",
          chain: "solana",
        },
        destination: {
          type: "payout_destination",
          payout_destination_id:
            input.payoutDestinationId,
        },
        metadata: input.metadata,
      },
    });

    return {
      transfer: transfer(response.body),
      idempotentReplayed:
        response.headers?.["idempotent-replayed"] === "true",
    };
  }
}
