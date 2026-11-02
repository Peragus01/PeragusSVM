import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import {
  CustomerDocumentService,
  DocumentRepository,
  MAX_DOCUMENT_BYTES,
  type DocumentRow,
  uploadGrant,
  validateDocument,
} from "../src/onboarding/customer-documents.js";
import { publicIPv4 } from "../src/providers/document-upload.js";
import { OzavClient } from "../src/providers/ozav-client.js";

const db = new PGlite();
const pool = {
  query: async (sql: string, params?: unknown[]) => {
    const r = await db.query(sql, params);
    return { ...r, rowCount: r.rows.length };
  },
} as unknown as Pool;
const repo = new DocumentRepository(pool);
const jpeg = () => Buffer.from([255, 216, 255, 224, 11, 12, 13, 14, 255, 217]);
const origins = new Set(["https://storage.ozav.io"]);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
beforeAll(async () => {
  await db.exec(
    "create role anon;create role authenticated;create table peragus_customers(id uuid primary key);",
  );
  await db.exec(
    await readFile(
      new URL(
        "../migrations/038_add_customer_document_uploads.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}, 30000);
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});
async function setup() {
  const customer = randomUUID(),
    owner = randomUUID(),
    providerCustomer = "ozav_cus_" + randomUUID().replaceAll("-", "");
  await db.query("insert into peragus_customers values($1)", [customer]);
  const input = {
    request_id: randomUUID(),
    doc_type: "identity_document" as const,
    side: "front" as const,
    mime: "image/jpeg" as const,
  };
  const documentId = "ozav_doc_" + randomUUID().replaceAll("-", "");
  const caps = {
    environment: "test",
    entitlements: ["customers"],
    scopes: ["customers:read", "customers:write"],
  };
  let declaration: Record<string, unknown> = {};
  let received = false;
  let wrongHash = false;
  let wrongCustomer = false;
  const provider = {
    getCustomerCapabilities: vi.fn(async () => caps),
    declareCustomerDocument: vi.fn(
      async (id: string, body: Record<string, unknown>) => {
        expect(id).toBe(providerCustomer);
        declaration = body;
        return {
          id: documentId,
          object: "document",
          subject_type: "customer",
          customer_id: providerCustomer,
          doc_type: body.doc_type,
          side: body.side ?? null,
          status: "pending_upload",
          mime: body.mime,
          upload_url:
            "https://storage.ozav.io/upload/test?signature=private-upload-token",
          upload_expires_at: new Date(Date.now() + 60000).toISOString(),
        };
      },
    ),
    listCustomerDocuments: vi.fn(async () => ({
      data: [
        {
          id: documentId,
          object: "document",
          subject_type: "customer",
          customer_id: wrongCustomer ? "ozav_cus_foreign" : providerCustomer,
          doc_type: declaration.doc_type,
          side: declaration.side ?? null,
          status: received ? "received" : "pending_upload",
          mime: declaration.mime,
          sha256: wrongHash ? "0".repeat(64) : declaration.sha256,
          size_bytes: declaration.size_bytes,
        },
      ],
      has_more: false,
      next_cursor: null,
    })),
  };
  const upload = vi.fn(async (_url: URL, _bytes: Buffer, _mime: string) => {
    received = true;
  });
  const binding = {
    find: vi.fn(async () => ({
      state: "linked",
      providerId: providerCustomer,
      verificationMode: "full",
    })),
  };
  const service = new CustomerDocumentService(
    repo,
    binding as never,
    provider,
    origins,
    upload,
  );
  const actor = {
    id: customer,
    ownerUserId: owner,
    type: "pf" as const,
    displayName: "Synthetic",
    verificationStatus: "draft" as const,
    suspended: false,
  };
  return {
    customer,
    owner,
    input,
    provider,
    upload,
    binding,
    service,
    actor,
    caps,
    setReceived: () => {
      received = true;
    },
    setHashMismatch: () => {
      wrongHash = true;
    },
    setForeign: () => {
      wrongCustomer = true;
    },
  };
}
async function appFor(s: Awaited<ReturnType<typeof setup>>, enabled = true) {
  const access = {
    authenticate: async (token: string) => {
      if (token !== "valid") throw new AuthenticationError("INVALID_TOKEN");
      return { id: s.owner, email: "synthetic@example.test" };
    },
    customers: {
      findByOwner: async () => s.actor,
      createOrGet: async () => ({ customer: s.actor, created: false }),
      ownsSettlement: async () => false,
    },
  };
  const app = await buildApp({
    customerAccess: access,
    ...(enabled ? { customerDocumentService: s.service } : {}),
  });
  apps.push(app);
  return app;
}
const headers = (s: Awaited<ReturnType<typeof setup>>) => ({
  authorization: "Bearer valid",
  "content-type": s.input.mime,
  "idempotency-key": s.input.request_id,
  "x-document-type": s.input.doc_type,
  "x-document-side": s.input.side,
});
describe("private PF document uploads", () => {
  it("records only safe failure categories and preserves ambiguous outcomes without retry", async () => {
    const s = await setup();
    const diagnostic = vi.fn();
    const service = new CustomerDocumentService(
      repo,
      s.binding as never,
      s.provider,
      origins,
      s.upload,
      diagnostic,
    );
    s.provider.declareCustomerDocument.mockImplementationOnce(async () => {
      throw new Error("sensitive provider URL and token");
    });
    await expect(
      service.send(s.customer, s.input, jpeg()),
    ).rejects.toMatchObject({ code: "DOCUMENT_UPLOAD_UNCONFIRMED" });
    expect(diagnostic).toHaveBeenCalledWith({
      stage: "declaration",
      reason: "UNCLASSIFIED",
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("sensitive");
    expect((await service.list(s.customer))[0]?.state).toBe("uncertain");
    expect(s.provider.declareCustomerDocument).toHaveBeenCalledTimes(1);
    expect(s.upload).not.toHaveBeenCalled();
  });
  it("distinguishes a rejected upload origin without logging its URL", async () => {
    const s = await setup();
    const diagnostic = vi.fn();
    const original =
      s.provider.declareCustomerDocument.getMockImplementation()!;
    s.provider.declareCustomerDocument.mockImplementationOnce(
      async (...args) => ({
        ...(await original(...args)),
        upload_url: "https://elsewhere.invalid/secret?token=private",
      }),
    );
    const service = new CustomerDocumentService(
      repo,
      s.binding as never,
      s.provider,
      origins,
      s.upload,
      diagnostic,
    );
    await expect(
      service.send(s.customer, s.input, jpeg()),
    ).rejects.toMatchObject({ code: "DOCUMENT_UPLOAD_UNCONFIRMED" });
    expect(diagnostic).toHaveBeenCalledWith({
      stage: "grant_validation",
      reason: "DOCUMENT_UPLOAD_ORIGIN_OTHER",
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /token|elsewhere|secret/,
    );
    expect(s.upload).not.toHaveBeenCalled();
  });
  it("uploads only once, confirms the provider hash and stores no bytes or signed URL", async () => {
    const s = await setup();
    const first = await s.service.send(s.customer, s.input, jpeg());
    expect(first.data).toMatchObject({
      state: "received",
      identity_verified: false,
      operations_enabled: false,
    });
    expect((await s.service.send(s.customer, s.input, jpeg())).replayed).toBe(
      true,
    );
    expect(s.provider.declareCustomerDocument).toHaveBeenCalledTimes(1);
    expect(s.upload).toHaveBeenCalledTimes(1);
    const stored = JSON.stringify(
      (
        await db.query(
          "select * from peragus_customer_document_uploads where customer_id=$1",
          [s.customer],
        )
      ).rows,
    );
    expect(stored).not.toMatch(
      /upload_url|signature=|private-upload-token|ciphertext/,
    );
    expect(JSON.stringify(first)).not.toMatch(
      /sha256|provider_customer|upload_url|private/,
    );
  });
  it("restores only own metadata and preserves unknown versus empty provider requirements", async () => {
    const s = await setup();
    const first = await s.service.send(s.customer, s.input, jpeg());
    expect((await s.service.list(s.customer)).map((row) => row.id)).toContain(
      first.data.id,
    );
    expect(await s.service.list(randomUUID())).toEqual([]);
    expect(
      (await s.service.requirements(s.customer)).required_documents,
    ).toBeNull();
    s.provider.listCustomerDocuments.mockResolvedValueOnce({
      data: [],
      has_more: false,
      still_required: [],
    } as never);
    expect(
      (await s.service.requirements(s.customer)).required_documents,
    ).toEqual([]);
    s.provider.listCustomerDocuments.mockResolvedValueOnce({
      data: [],
      has_more: false,
      still_required: ["liveness", "identity_document"],
      private_reason: "must not return",
    } as never);
    const required = await s.service.requirements(s.customer);
    expect(required.required_documents).toEqual([
      { doc_type: "liveness", supported_for_upload: false },
      { doc_type: "identity_document", supported_for_upload: true },
    ]);
    expect(JSON.stringify(required)).not.toContain("private_reason");
  });
  it("accepts an unknown pre-upload MIME but still requires matching observed receipt", async () => {
    const s = await setup();
    const original =
      s.provider.declareCustomerDocument.getMockImplementation()!;
    s.provider.declareCustomerDocument.mockImplementationOnce(
      async (id, body) =>
        ({
          ...(await original(id, body)),
          mime: null,
          subject_type: undefined,
        }) as never,
    );
    expect((await s.service.send(s.customer, s.input, jpeg())).data.state).toBe(
      "received",
    );
  });
  it("serializes concurrent requests with the same key and refuses altered payloads", async () => {
    const s = await setup();
    await Promise.all([
      s.service.send(s.customer, s.input, jpeg()),
      s.service.send(s.customer, s.input, jpeg()),
    ]);
    expect(s.provider.declareCustomerDocument).toHaveBeenCalledTimes(1);
    const changed = jpeg();
    changed[4] = 99;
    await expect(s.service.send(s.customer, s.input, changed)).rejects.toThrow(
      "DOCUMENT_IDEMPOTENCY_CONFLICT",
    );
  });
  it("blocks automatic redeclaration after an uncertain POST or PUT", async () => {
    for (const stage of ["declare", "upload"]) {
      const s = await setup();
      if (stage === "declare")
        s.provider.declareCustomerDocument.mockRejectedValueOnce(
          Error("secret response"),
        );
      else s.upload.mockRejectedValueOnce(Error("secret signed URL"));
      await expect(s.service.send(s.customer, s.input, jpeg())).rejects.toThrow(
        "DOCUMENT_UPLOAD_UNCONFIRMED",
      );
      expect(
        (await s.service.send(s.customer, s.input, jpeg())).data.state,
      ).toBe("uncertain");
      expect(s.provider.declareCustomerDocument).toHaveBeenCalledTimes(1);
      await expect(
        s.service.send(
          s.customer,
          { ...s.input, request_id: randomUUID() },
          jpeg(),
        ),
      ).rejects.toThrow("DOCUMENT_IDEMPOTENCY_CONFLICT");
    }
  });
  it("recovers a timeout through GET only and does not fabricate receipt on hash mismatch", async () => {
    const s = await setup();
    s.upload.mockImplementationOnce(async () => {
      throw Error("uncertain");
    });
    await expect(s.service.send(s.customer, s.input, jpeg())).rejects.toThrow(
      "DOCUMENT_UPLOAD_UNCONFIRMED",
    );
    const row = (
      await db.query<{ id: string }>(
        "select id from peragus_customer_document_uploads where customer_id=$1",
        [s.customer],
      )
    ).rows[0]!;
    expect((await s.service.refresh(s.customer, row.id)).state).toBe(
      "uncertain",
    );
    // Provider later confirms bytes, without another declaration or upload.
    s.setReceived();
    expect((await s.service.refresh(s.customer, row.id)).state).toBe(
      "received",
    );
    expect(s.upload).toHaveBeenCalledTimes(1);
    const s2 = await setup();
    s2.setHashMismatch();
    expect(
      (await s2.service.send(s2.customer, s2.input, jpeg())).data.state,
    ).toBe("pending_confirmation");
  });
  it("denies cross-customer reads and mismatched provider observations", async () => {
    const s = await setup();
    const sent = await s.service.send(s.customer, s.input, jpeg());
    await expect(s.service.read(randomUUID(), sent.data.id)).rejects.toThrow(
      "DOCUMENT_NOT_FOUND",
    );
    s.setForeign();
    await expect(s.service.refresh(s.customer, sent.data.id)).rejects.toThrow(
      "DOCUMENT_BINDING_CONFLICT",
    );
  });
  it("rejects malformed, oversize and active PDF bytes before provider calls", async () => {
    const s = await setup();
    for (const data of [
      Buffer.from("not jpeg"),
      Buffer.alloc(MAX_DOCUMENT_BYTES + 1),
    ])
      await expect(s.service.send(s.customer, s.input, data)).rejects.toThrow(
        "DOCUMENT_VALIDATION_ERROR",
      );
    const pdf = {
      ...s.input,
      doc_type: "proof_of_address" as const,
      side: "none" as const,
      mime: "application/pdf" as const,
    };
    expect(() =>
      validateDocument(pdf, Buffer.from("%PDF-1.7\n/JavaScript\n%%EOF")),
    ).toThrow("DOCUMENT_VALIDATION_ERROR");
    expect(s.provider.declareCustomerDocument).not.toHaveBeenCalled();
  });
  it("rejects live capabilities in this staging implementation", async () => {
    const s = await setup();
    s.caps.environment = "live";
    await expect(s.service.send(s.customer, s.input, jpeg())).rejects.toThrow(
      "DOCUMENT_CAPABILITY_REQUIRED",
    );
    expect(s.provider.declareCustomerDocument).not.toHaveBeenCalled();
  });
  it("requires auth, feature and PF access before accepting a body; route response is sanitized", async () => {
    const s = await setup(),
      off = await appFor(s, false),
      app = await appFor(s);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/me/onboarding/documents",
          headers: { "content-type": "image/jpeg" },
          payload: jpeg(),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await off.inject({
          method: "POST",
          url: "/v1/me/onboarding/documents",
          headers: headers(s),
          payload: jpeg(),
        })
      ).statusCode,
    ).toBe(503);
    const result = await app.inject({
      method: "POST",
      url: "/v1/me/onboarding/documents",
      headers: headers(s),
      payload: jpeg(),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.state).toBe("received");
    const tooBig = await app.inject({
      method: "POST",
      url: "/v1/me/onboarding/documents",
      headers: headers(s),
      payload: Buffer.alloc(MAX_DOCUMENT_BYTES + 1),
    });
    expect(tooBig.statusCode).toBe(413);
    expect(s.provider.declareCustomerDocument).toHaveBeenCalledTimes(1);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).not.toContain("private-upload-token");
    s.actor.suspended = true;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/me/onboarding/documents",
          headers: headers(s),
          payload: jpeg(),
        })
      ).statusCode,
    ).toBe(403);
  });
  it("refuses arbitrary upload origins, credentials, fragments and expired grants", async () => {
    const s = await setup();
    await s.service.send(s.customer, s.input, jpeg());
    const row = (
      await db.query(
        "select * from peragus_customer_document_uploads where customer_id=$1",
        [s.customer],
      )
    ).rows[0] as unknown as DocumentRow;
    // Construct synthetic grants independently of provider spies.
    const grant = {
      id: "ozav_doc_11111111111111111111",
      object: "document",
      subject_type: "customer",
      customer_id: row.provider_customer_id,
      doc_type: "identity_document",
      side: "front",
      mime: "image/jpeg",
      status: "pending_upload",
      upload_expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    for (const [url, reason] of [
      ["http://storage.ozav.io/x", "DOCUMENT_UPLOAD_URL_INVALID"],
      ["https://evil.example/x", "DOCUMENT_UPLOAD_ORIGIN_OTHER"],
      [
        "https://storage.googleapis.com/x?secret=redacted",
        "DOCUMENT_UPLOAD_ORIGIN_GOOGLE_STORAGE",
      ],
      ["https://user:pass@storage.ozav.io/x", "DOCUMENT_UPLOAD_URL_INVALID"],
      ["https://storage.ozav.io/x#fragment", "DOCUMENT_UPLOAD_URL_INVALID"],
    ])
      expect(() =>
        uploadGrant({ ...grant, upload_url: url }, row, origins),
      ).toThrow(reason);
    expect(() =>
      uploadGrant(
        {
          ...grant,
          upload_url: "https://storage.ozav.io/upload",
          upload_expires_at: new Date(0).toISOString(),
        },
        row,
        origins,
      ),
    ).toThrow("DOCUMENT_UPLOAD_EXPIRY_TOO_SOON");
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "172.16.1.2",
      "192.168.0.1",
      "::1",
    ])
      expect(publicIPv4(ip)).toBe(false);
    expect(publicIPv4("1.1.1.1")).toBe(true);
  });
  it("uses the canonical document endpoints without adding upload credentials", async () => {
    const s = await setup();
    const write = vi.fn(async () => ({
      statusCode: 201,
      body: { id: "synthetic" },
    }));
    const read = vi.fn(async () => ({
      statusCode: 200,
      body: { data: [], has_more: false },
    }));
    const client = new OzavClient({
      apiKey: "ozav_sk_test_synthetic",
      attempts: 1,
      writeTransport: write,
      transport: read,
    });
    const providerCustomer = "ozav_cus_11111111111111111111";
    const unsafeClient = new OzavClient({
      apiKey: "ozav_sk_test_synthetic",
      writeTransport: write,
      transport: read,
    });
    await expect(
      unsafeClient.declareCustomerDocument(providerCustomer, {
        doc_type: "selfie",
      }),
    ).rejects.toThrow("Document declaration requires one attempt");
    expect(write).not.toHaveBeenCalled();
    await client.declareCustomerDocument(providerCustomer, {
      doc_type: "selfie",
    });
    await client.listCustomerDocuments(providerCustomer);
    expect(write.mock.calls[0]?.[0]).toEqual({
      path: `/v2/customers/${providerCustomer}/documents`,
      body: { doc_type: "selfie" },
    });
    expect(read.mock.calls[0]?.[0]).toBe(
      `/v2/customers/${providerCustomer}/documents?limit=100`,
    );
    expect(s.upload).not.toHaveBeenCalled();
  });
});
