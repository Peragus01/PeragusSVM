import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { PostgresSettlementRepository } from "../src/repositories/postgres-settlement-repository.js";
import { CreateSettlementService } from "../src/application/create-settlement.js";
import { SettlementOrchestrationHandler } from "../src/jobs/settlement-orchestration.js";

const db = new PGlite();
const pool = { query: async (sql: string, params?: unknown[]) => {
  const result = await db.query(sql, params);
  return { ...result, rowCount: result.rows.length };
} } as unknown as Pool;
const repository = new PostgresSettlementRepository(pool);
const customers = new PostgresCustomerRepository(pool);
const actors = { pf: randomUUID(), pj: randomUUID(), empty: randomUUID() };
const publisher = { enqueue: vi.fn(async () => { throw new Error("No draft may be published"); }) };
const funder = { ensureFunded: vi.fn(async () => { throw new Error("No draft may be funded"); }) };
const authenticated = async (token: string) => {
  const id = actors[token as keyof typeof actors];
  if (!id) throw new AuthenticationError("INVALID_TOKEN");
  return { id, email: `${token}@example.test` };
};
const options = { customerAccess: { authenticate: authenticated, customers }, settlementRepository: repository,
  settlementJobPublisher: publisher, demoWalletFunder: funder };
let app: Awaited<ReturnType<typeof buildApp>>;
let disabled: Awaited<ReturnType<typeof buildApp>>;
let pfId: string, pjId: string, legacyId: string;
const headers = (who = "pf") => ({ authorization: `Bearer ${who}` });
const payload = (key = randomUUID()) => ({
  request_id: key, corridor_id: "ab".repeat(32),
  payer_wallet: "11111111111111111111111111111112",
  recipient_wallet: "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
  source_amount: "1", destination_amount: "1", expires_at: "2099-01-01T00:00:00.000Z",
});
const post = (who: string, body = payload()) => app.inject({ method: "POST", url: "/v1/settlement-drafts", headers: headers(who), payload: body });
beforeAll(async () => {
  const dir = new URL("../migrations/", import.meta.url);
  const files = (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) await db.exec(await readFile(new URL(f, dir), "utf8"));
  pfId = (await customers.createOrGet({ ownerUserId: actors.pf, type: "pf", displayName: "PF test" })).customer.id;
  pjId = (await customers.createOrGet({ ownerUserId: actors.pj, type: "pj", displayName: "PJ test" })).customer.id;
  app = await buildApp({ ...options, customerDraftRepository: id => PostgresSettlementRepository.forCustomerDrafts(pool, id) });
  disabled = await buildApp(options);
  const legacy = await new CreateSettlementService(repository).execute({ requestId: "shared-legacy-key", corridorId: "ab".repeat(32), payerWallet: "payer", recipientWallet: "recipient", sourceAmount: "1", destinationAmount: "1", expiresAt: "2099-01-01T00:00:00Z" });
  legacyId = legacy.settlement.id;
}, 30000);
afterAll(async () => { await Promise.all([app.close(), disabled.close()]); await db.close(); });

describe("owned non-executable settlement records", () => {
  it("requires a valid session, a customer and the explicit feature capability", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/settlement-drafts", payload: payload() })).statusCode).toBe(401);
    expect((await post("bad")).statusCode).toBe(401);
    expect((await post("empty")).statusCode).toBe(403);
    expect((await disabled.inject({ method: "POST", url: "/v1/settlement-drafts", headers: headers(), payload: payload() })).statusCode).toBe(503);
  });
  it("creates an owned PF record without funding or publishing", async () => {
    const response = await post("pf");
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ customer_id: pfId, record_only: true, status: "created" });
    expect(response.json().meta).toEqual({ idempotent_replay: false, record_only: true, job_enqueued: false, operations_enabled: false });
    expect(response.headers.location).toBe(`/v1/settlements/${response.json().data.id}`);
    expect(publisher.enqueue).not.toHaveBeenCalled(); expect(funder.ensureFunded).not.toHaveBeenCalled();
  });
  it("isolates idempotency by customer and detects conflicts only within that customer", async () => {
    const input = payload("same-request-pf-and-pj");
    const pf = await post("pf", input), replay = await post("pf", input);
    const pj = await post("pj", { ...input, source_amount: "2" });
    expect(pf.statusCode).toBe(201); expect(replay.statusCode).toBe(200); expect(pj.statusCode).toBe(201);
    expect(replay.json().data.id).toBe(pf.json().data.id);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(pj.json().data.id).not.toBe(pf.json().data.id);
    expect(pj.json().data.customer_id).toBe(pjId);
    const conflict = await post("pf", { ...input, source_amount: "2" });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    const count = await db.query<{ count: number }>("select count(*)::int as count from settlements where request_id=$1", [input.request_id]);
    expect(count.rows[0]?.count).toBe(2);
  });
  it("returns own records and hides the other customer's record across every subresource, in both directions", async () => {
    for (const [owner, other] of [["pf", "pj"], ["pj", "pf"]]) {
      const created = await post(owner!); const id = created.json().data.id;
      expect((await app.inject({ method: "GET", url: `/v1/settlements/${id}`, headers: headers(owner) })).statusCode).toBe(200);
      for (const [method, suffix] of [["GET", ""], ["GET", "/audit"], ["GET", "/onramp"], ["POST", "/offramp"], ["POST", "/onramp/simulate-payment"], ["POST", "/solana/prepare"], ["POST", "/solana/confirm"], ["POST", "/solana/rollback-demo/prepare"]] as const) {
        const response = await app.inject({ method, url: `/v1/settlements/${id}${suffix}`, headers: headers(other) });
        expect(response.statusCode).toBe(404); expect(response.json().error.code).toBe("SETTLEMENT_NOT_FOUND");
      }
    }
  });
  it.each(["customer_id", "owner_user_id", "record_only", "verification_status"])("rejects client-supplied %s", async field => {
    const response = await post("pf", { ...payload(), [field]: pjId });
    expect(response.statusCode).toBe(400);
  });
  it("does not let a header or query override the authenticated customer", async () => {
    const response = await app.inject({ method: "POST", url: `/v1/settlement-drafts?customer_id=${pjId}`, headers: { ...headers(), "x-customer-id": pjId }, payload: payload() });
    expect(response.statusCode).toBe(201); expect(response.json().data.customer_id).toBe(pfId);
  });
  it("keeps legacy records hidden and legacy request IDs in a separate namespace", async () => {
    const own = await post("pf", payload("shared-legacy-key")); expect(own.statusCode).toBe(201);
    expect((await repository.findByRequestId("shared-legacy-key"))?.id).toBe(legacyId);
    expect((await app.inject({ method: "GET", url: `/v1/settlements/${legacyId}`, headers: headers() })).statusCode).toBe(404);
    expect(await PostgresSettlementRepository.forCustomerDrafts(pool, pjId).findByRequestId("shared-legacy-key")).toBeNull();
    expect(await PostgresSettlementRepository.forCustomerDrafts(pool, pjId).findById(own.json().data.id)).toBeNull();
  });
  it("handles concurrent identical and conflicting requests without duplicate customer records", async () => {
    const input = payload();
    const results = await Promise.all([post("pf", input), post("pf", input), post("pf", { ...input, source_amount: "2" })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 201, 409]);
    const rows = await db.query("select id from settlements where customer_id=$1 and request_id=$2", [pfId, input.request_id]);
    expect(rows.rows).toHaveLength(1);
  });
  it("refuses orchestration, financial transitions and promotion at the database", async () => {
    const created = await post("pf"); const record = created.json().data;
    await expect(new SettlementOrchestrationHandler(repository).execute({ settlementId: record.id, requestId: record.request_id })).rejects.toThrow("RECORD_ONLY_SETTLEMENT");
    expect(await repository.updateStatus({ id: record.id, expectedStatus: "created", expectedVersion: 0, nextStatus: "awaiting_pix", occurredAt: new Date() })).toBeNull();
    await expect(db.query("update settlements set status='awaiting_pix' where id=$1", [record.id])).rejects.toThrow();
    await expect(db.query("update settlements set record_only=false where id=$1", [record.id])).rejects.toThrow();
    await expect(db.query("update settlements set customer_id=$1 where id=$2", [pjId, record.id])).rejects.toThrow();
  });
  it("keeps existing financial POST routes blocked for an owned record", async () => {
    const record = (await post("pf")).json().data;
    for (const url of ["/v1/settlements", `/v1/settlements/${record.id}/onramp/simulate-payment`, `/v1/settlements/${record.id}/solana/prepare`]) {
      expect((await app.inject({ method: "POST", url, headers: headers(), payload: {} })).statusCode).toBe(403);
    }
    expect(publisher.enqueue).not.toHaveBeenCalled(); expect(funder.ensureFunded).not.toHaveBeenCalled();
  });
  it("blocks suspended customers before any draft insert", async () => {
    await db.query("update peragus_customers set suspended=true where id=$1", [pjId]);
    const response = await post("pj"); expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CUSTOMER_SUSPENDED");
    await db.query("update peragus_customers set suspended=false where id=$1", [pjId]);
  });
});
