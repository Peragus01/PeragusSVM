import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { SubmissionRepository } from "./submission-types.js";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export class DocumentError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const invalid = (): never => {
  throw new DocumentError("DOCUMENT_VALIDATION_ERROR");
};
export const documentInput = z
  .object({
    request_id: z.uuid(),
    doc_type: z.enum(["identity_document", "selfie", "proof_of_address"]),
    side: z.enum(["front", "back", "single", "none"]),
    mime: z.enum(["image/jpeg", "image/png", "application/pdf"]),
  })
  .strict();
export type DocumentInput = z.infer<typeof documentInput>;
export type DocumentRow = DocumentInput & {
  id: string;
  customer_id: string;
  provider_customer_id: string;
  size_bytes: number;
  sha256: string;
  fingerprint: string;
  provider_document_id: string | null;
  state:
    | "declaring"
    | "uploading"
    | "pending_confirmation"
    | "received"
    | "rejected"
    | "uncertain";
};
export interface DocumentProvider {
  getCustomerCapabilities(): Promise<{
    environment: string;
    entitlements: string[];
    scopes: string[];
  }>;
  declareCustomerDocument(
    customerId: string,
    body: Record<string, unknown>,
  ): Promise<unknown>;
  listCustomerDocuments(customerId: string, cursor?: string): Promise<unknown>;
}
export function validateDocument(input: DocumentInput, bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) invalid();
  if ((input.doc_type === "identity_document") !== (input.side !== "none"))
    invalid();
  if (input.mime === "application/pdf") {
    if (
      input.doc_type !== "proof_of_address" ||
      !/^%PDF-1\.[0-7]/.test(bytes.subarray(0, 8).toString("ascii")) ||
      !bytes.subarray(-1024).includes(Buffer.from("%%EOF")) ||
      /\/(JavaScript|JS|OpenAction|AA|EmbeddedFile|Launch|RichMedia)\b/.test(
        bytes.toString("latin1"),
      )
    )
      invalid();
  } else if (input.mime === "image/png") {
    if (
      bytes.length < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      !bytes.subarray(-8, -4).equals(Buffer.from("IEND"))
    )
      invalid();
  } else if (
    bytes.length < 4 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes[2] !== 255 ||
    bytes[bytes.length - 2] !== 255 ||
    bytes[bytes.length - 1] !== 217
  )
    invalid();
}
export class DocumentRepository {
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async find(customer: string, id: string) {
    return (
      (
        await this.pool.query<DocumentRow>(
          "select * from peragus_customer_document_uploads where customer_id=$1 and id=$2",
          [customer, id],
        )
      ).rows[0] ?? null
    );
  }
  async list(customer: string) {
    return (
      await this.pool.query<DocumentRow>(
        "select * from peragus_customer_document_uploads where customer_id=$1 order by created_at desc,id desc limit 50",
        [customer],
      )
    ).rows;
  }
  async reserve(
    row: DocumentRow,
  ): Promise<{ row: DocumentRow; created: boolean }> {
    const inserted = await this.pool.query<DocumentRow>(
      `insert into peragus_customer_document_uploads
      (id,customer_id,provider_customer_id,request_id,doc_type,side,mime,size_bytes,sha256,fingerprint,state)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'declaring') on conflict do nothing returning *`,
      [
        row.id,
        row.customer_id,
        row.provider_customer_id,
        row.request_id,
        row.doc_type,
        row.side,
        row.mime,
        row.size_bytes,
        row.sha256,
        row.fingerprint,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const prior = (
      await this.pool.query<DocumentRow>(
        "select * from peragus_customer_document_uploads where customer_id=$1 and request_id=$2",
        [row.customer_id, row.request_id],
      )
    ).rows[0];
    if (!prior || prior.fingerprint !== row.fingerprint)
      throw new DocumentError("DOCUMENT_IDEMPOTENCY_CONFLICT");
    return { row: prior, created: false };
  }
  async update(
    row: DocumentRow,
    state: DocumentRow["state"],
    providerId = row.provider_document_id,
  ) {
    const result = await this.pool.query<DocumentRow>(
      `update peragus_customer_document_uploads set state=$3,provider_document_id=$4,updated_at=now()
      where customer_id=$1 and id=$2 and state=$5 returning *`,
      [row.customer_id, row.id, state, providerId, row.state],
    );
    if (!result.rows[0]) throw new DocumentError("DOCUMENT_STATE_CONFLICT");
    return result.rows[0];
  }
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new DocumentError("DOCUMENT_PROVIDER_INVALID");
  return v as Record<string, unknown>;
};
export function uploadGrant(
  value: unknown,
  row: DocumentRow,
  origins: ReadonlySet<string>,
  now = Date.now(),
) {
  const v = object(value);
  if (
    typeof v.id !== "string" ||
    !/^ozav_doc_[A-Za-z0-9]{16,}$/.test(v.id) ||
    v.object !== "document" ||
    v.customer_id !== row.provider_customer_id ||
    v.doc_type !== row.doc_type ||
    (v.subject_type != null && v.subject_type !== "customer") ||
    v.associated_person_id != null ||
    v.status !== "pending_upload" ||
    (v.mime != null && v.mime !== row.mime) ||
    (v.side ?? "none") !== row.side ||
    typeof v.upload_url !== "string" ||
    typeof v.upload_expires_at !== "string"
  )
    throw new DocumentError("DOCUMENT_PROVIDER_INVALID");
  const expires = Date.parse(v.upload_expires_at);
  let url: URL;
  try {
    url = new URL(v.upload_url);
  } catch {
    throw new DocumentError("DOCUMENT_UPLOAD_ORIGIN_REFUSED");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  )
    throw new DocumentError("DOCUMENT_UPLOAD_URL_INVALID");
  if (!origins.has(url.origin)) {
    const kind =
      url.hostname === "storage.googleapis.com" ? "GOOGLE_STORAGE" : "OTHER";
    throw new DocumentError(`DOCUMENT_UPLOAD_ORIGIN_${kind}`);
  }
  if (!Number.isFinite(expires))
    throw new DocumentError("DOCUMENT_UPLOAD_EXPIRY_INVALID");
  if (expires <= now + 5000)
    throw new DocumentError("DOCUMENT_UPLOAD_EXPIRY_TOO_SOON");
  if (expires > now + 86400000)
    throw new DocumentError("DOCUMENT_UPLOAD_EXPIRY_TOO_LATE");
  return { id: v.id, url };
}
const view = (row: DocumentRow) => ({
  id: row.id,
  doc_type: row.doc_type,
  side: row.side,
  state: row.state,
  environment: "test",
  identity_verified: false,
  operations_enabled: false,
});
export class CustomerDocumentService {
  constructor(
    private readonly repo: DocumentRepository,
    private readonly submissions: Pick<SubmissionRepository, "find">,
    private readonly provider: DocumentProvider,
    private readonly origins: ReadonlySet<string>,
    private readonly upload: (
      url: URL,
      bytes: Buffer,
      mime: string,
    ) => Promise<void>,
    private readonly diagnostic: (entry: {
      stage: string;
      reason: string;
      hostname?: string;
    }) => void = () => {},
  ) {}
  private async binding(customer: string) {
    const b = await this.submissions.find(customer);
    if (
      !b ||
      b.state !== "linked" ||
      !b.providerId ||
      b.verificationMode !== "full"
    )
      throw new DocumentError("DOCUMENT_CUSTOMER_REQUIRED");
    return b.providerId;
  }
  private async capabilities() {
    const c = await this.provider.getCustomerCapabilities();
    if (
      c.environment !== "test" ||
      !c.entitlements.includes("customers") ||
      !["customers:read", "customers:write"].every((s) => c.scopes.includes(s))
    )
      throw new DocumentError("DOCUMENT_CAPABILITY_REQUIRED");
  }
  async list(customer: string) {
    return (await this.repo.list(customer)).map(view);
  }
  async requirements(customer: string) {
    const providerCustomer = await this.binding(customer);
    await this.capabilities();
    const result = object(
      await this.provider.listCustomerDocuments(providerCustomer),
    );
    const types = [
      "identity_document",
      "selfie",
      "liveness",
      "proof_of_address",
      "company_registration",
      "ownership_structure",
      "financial_statement",
      "source_of_funds",
      "bank_statement",
      "authorized_signature_form",
      "banking_reference",
      "corporate_resolution",
      "good_standing_certificate",
      "source_of_funds_certification",
      "tax_registration",
      "pep_declaration",
      "income_tax_return",
      "other",
    ];
    let required: null | { doc_type: string; supported_for_upload: boolean }[] =
      null;
    if (result.still_required !== undefined) {
      if (
        !Array.isArray(result.still_required) ||
        result.still_required.length > types.length ||
        result.still_required.some(
          (v) => typeof v !== "string" || !types.includes(v),
        )
      )
        throw new DocumentError("DOCUMENT_PROVIDER_INVALID");
      required = [...new Set(result.still_required as string[])].map(
        (doc_type) => ({
          doc_type,
          supported_for_upload: [
            "identity_document",
            "selfie",
            "proof_of_address",
          ].includes(doc_type),
        }),
      );
    }
    return {
      required_documents: required,
      source: "provider_observation",
      environment: "test",
      identity_verified: false,
      operations_enabled: false,
    };
  }
  async send(customer: string, input: DocumentInput, bytes: Buffer) {
    validateDocument(input, bytes);
    const providerCustomer = await this.binding(customer);
    await this.capabilities();
    if (!this.origins.size)
      throw new DocumentError("DOCUMENT_UPLOAD_ORIGIN_REFUSED");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          customer,
          providerCustomer,
          input.doc_type,
          input.side,
          input.mime,
          bytes.length,
          sha256,
        ]),
      )
      .digest("hex");
    const reservation = await this.repo.reserve({
      ...input,
      id: randomUUID(),
      customer_id: customer,
      provider_customer_id: providerCustomer,
      size_bytes: bytes.length,
      sha256,
      fingerprint,
      provider_document_id: null,
      state: "declaring",
    });
    let row = reservation.row;
    if (!reservation.created) return { data: view(row), replayed: true };
    let stage = "declaration";
    let rejectedHostname: string | undefined;
    try {
      const raw = await this.provider.declareCustomerDocument(
        providerCustomer,
        {
          subject_type: "customer",
          doc_type: input.doc_type,
          ...(input.side !== "none"
            ? { side: input.side, issuing_country: "BR" }
            : {}),
          mime: input.mime,
          size_bytes: bytes.length,
          sha256,
        },
      );
      stage = "grant_validation";
      // The test-only diagnostic retains only an HTTPS hostname, never the path or query.
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const urlValue = (raw as Record<string, unknown>).upload_url;
        if (typeof urlValue === "string") {
          try {
            const parsed = new URL(urlValue);
            if (
              parsed.protocol === "https:" &&
              !parsed.username &&
              !parsed.password &&
              !parsed.port &&
              !parsed.hash &&
              /^[a-z0-9.-]{1,253}$/.test(parsed.hostname)
            )
              rejectedHostname = parsed.hostname;
          } catch {
            /* No URL details are retained. */
          }
        }
      }
      const grant = uploadGrant(raw, row, this.origins);
      stage = "save_provider_id";
      row = await this.repo.update(row, "uploading", grant.id);
      stage = "upload";
      // No API credential, cookie or caller header is passed to the upload transport.
      await this.upload(grant.url, bytes, input.mime);
      stage = "save_upload_state";
      row = await this.repo.update(row, "pending_confirmation");
    } catch (error) {
      const allowed = [
        "DOCUMENT_PROVIDER_INVALID",
        "DOCUMENT_UPLOAD_ORIGIN_REFUSED",
        "DOCUMENT_UPLOAD_URL_INVALID",
        "DOCUMENT_UPLOAD_ORIGIN_GOOGLE_STORAGE",
        "DOCUMENT_UPLOAD_ORIGIN_OTHER",
        "DOCUMENT_UPLOAD_EXPIRY_INVALID",
        "DOCUMENT_UPLOAD_EXPIRY_TOO_SOON",
        "DOCUMENT_UPLOAD_EXPIRY_TOO_LATE",
        "DOCUMENT_STATE_CONFLICT",
      ];
      const reason =
        error instanceof DocumentError && allowed.includes(error.code)
          ? error.code
          : "UNCLASSIFIED";
      try {
        this.diagnostic({
          stage,
          reason,
          ...(reason === "DOCUMENT_UPLOAD_ORIGIN_OTHER" && rejectedHostname
            ? { hostname: rejectedHostname }
            : {}),
        });
      } catch {
        /* diagnostics cannot affect durable state */
      }
      try {
        row = await this.repo.update(row, "uncertain");
      } catch {
        /* Durable declaring/uploading state also prevents replay. */
      }
      throw new DocumentError("DOCUMENT_UPLOAD_UNCONFIRMED");
    }
    // PUT success is not proof of receipt or identity approval.
    try {
      return { data: await this.refresh(customer, row.id), replayed: false };
    } catch {
      return { data: view(row), replayed: false };
    }
  }
  async read(customer: string, id: string) {
    const row = await this.repo.find(customer, id);
    if (!row) throw new DocumentError("DOCUMENT_NOT_FOUND");
    return view(row);
  }
  async refresh(customer: string, id: string) {
    const row = await this.repo.find(customer, id);
    if (!row) throw new DocumentError("DOCUMENT_NOT_FOUND");
    const binding = await this.binding(customer);
    if (binding !== row.provider_customer_id)
      throw new DocumentError("DOCUMENT_BINDING_CONFLICT");
    if (!row.provider_document_id) return view(row);
    await this.capabilities();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const response = object(
        await this.provider.listCustomerDocuments(binding, cursor),
      );
      if (
        !Array.isArray(response.data) ||
        response.data.length > 100 ||
        typeof response.has_more !== "boolean"
      )
        throw new DocumentError("DOCUMENT_PROVIDER_INVALID");
      for (const entry of response.data) {
        const doc = object(entry);
        if (doc.id !== row.provider_document_id) continue;
        if (
          doc.object !== "document" ||
          doc.customer_id !== binding ||
          doc.doc_type !== row.doc_type ||
          (doc.side ?? "none") !== row.side ||
          (doc.subject_type != null && doc.subject_type !== "customer") ||
          doc.associated_person_id != null
        )
          throw new DocumentError("DOCUMENT_BINDING_CONFLICT");
        if (doc.status === "pending_upload") return view(row);
        if (
          !["received", "rejected"].includes(String(doc.status)) ||
          doc.sha256 !== row.sha256 ||
          doc.size_bytes !== row.size_bytes ||
          doc.mime !== row.mime
        )
          throw new DocumentError("DOCUMENT_RECEIPT_MISMATCH");
        if (row.state === doc.status) return view(row);
        return view(
          await this.repo.update(row, doc.status as "received" | "rejected"),
        );
      }
      if (!response.has_more) break;
      if (
        typeof response.next_cursor !== "string" ||
        !/^ozav_doc_[A-Za-z0-9]{16,}$/.test(response.next_cursor) ||
        seen.has(response.next_cursor)
      )
        throw new DocumentError("DOCUMENT_PROVIDER_INVALID");
      cursor = response.next_cursor;
      seen.add(cursor);
    }
    throw new DocumentError("DOCUMENT_RECEIPT_UNCONFIRMED");
  }
}
