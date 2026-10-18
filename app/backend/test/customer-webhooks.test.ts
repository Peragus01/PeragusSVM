import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { OzavSandboxCustomerService } from "../src/application/ozav-sandbox-customer.js";
import { OzavClient } from "../src/providers/ozav-client.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { PostgresCustomerWebhookProcessor } from "../src/repositories/postgres-customer-webhook.js";
import { PostgresSandboxCustomerLinkRepository } from "../src/repositories/postgres-sandbox-customer-link.js";
import { CustomerWebhookConflict, verifyCustomerSignature, type CustomerWebhookEvent } from "../src/webhooks/customer-event.js";

const secret = "ozav_whsec_test_do_not_strip_prefix";
const now = new Date("2026-10-18T12:00:00Z");
const t = Math.floor(now.getTime() / 1000);
const path = "/webhooks/customer-updates";
const event = (providerId = "ozav_cus_unknown"): CustomerWebhookEvent => ({
  id: `ozav_evt_${randomUUID().replaceAll("-", "")}`, object: "event", type: "customer.updated", livemode: false,
  created_at: now.toISOString(), data: { customer: { id: providerId, status: "approved", email: "private@example.test" } },
});
const sign = (raw: string, time = t, key = secret) => `t=${time},v1=${createHmac("sha256", key).update(`${time}.${raw}`).digest("hex")}`;
const headers = (raw: string, id: string) => ({ "content-type": "application/json", "x-ozav-signature": sign(raw), "x-ozav-event-id": id });
const digest = (e: CustomerWebhookEvent) => createHash("sha256").update(JSON.stringify(e)).digest("hex");
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
async function appFor(processor?: { process: any }) {
  const app = await buildApp(processor ? { customerWebhooks: { secret, processor, now: () => now } } : {});
  apps.push(app); return app;
}
afterAll(async () => { await Promise.all(apps.map(app => app.close())); });

describe("raw-body customer webhook receiver", () => {
  it("uses full secret and exact original bytes with constant-time digest checks", () => {
    const raw = '{ "a": 1 }';
    expect(verifyCustomerSignature(Buffer.from(raw), sign(raw), secret, now)).toBe(true);
    expect(verifyCustomerSignature(Buffer.from('{"a":1}'), sign(raw), secret, now)).toBe(false);
    expect(verifyCustomerSignature(Buffer.from(raw), sign(raw, t, secret.slice(11)), secret, now)).toBe(false);
    expect(verifyCustomerSignature(Buffer.from(raw), `t=${t},${sign(raw)}`, secret, now)).toBe(false);
    expect(verifyCustomerSignature(Buffer.from(raw), [sign(raw)], secret, now)).toBe(false);
    expect(verifyCustomerSignature(Buffer.from(raw), `t=${t},v1=bad,v1=${sign(raw).split("v1=")[1]}`, secret, now)).toBe(true);
  });
  it.each([-301, 301])("rejects delivery timestamp offset %s", offset => {
    const raw = "{}";
    expect(verifyCustomerSignature(Buffer.from(raw), sign(raw, t + offset), secret, now)).toBe(false);
  });
  it("accepts signed events without bearer auth and keeps other JSON parsing intact", async () => {
    const process = vi.fn(async () => "processed"), app = await appFor({ process });
    const e = event(), raw = JSON.stringify(e, null, 2);
    const r = await app.inject({ method: "POST", url: path, headers: headers(raw, e.id), payload: raw });
    expect(r.statusCode).toBe(200); expect(r.json().result).toBe("processed");
    expect(process.mock.calls[0]![0]).toEqual(e);
    expect(process.mock.calls[0]![1]).toBe(createHash("sha256").update(raw).digest("hex"));
    const json = await app.inject({ method: "POST", url: "/v1/settlements", payload: {} });
    expect(json.statusCode).not.toBe(415);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
  it("uses signature authentication alongside protected customer routes", async () => {
    const process = vi.fn(async () => "ignored");
    const authenticate = vi.fn(async () => { throw new Error("bearer should not be used"); });
    const app = await buildApp({ customerWebhooks: { secret, processor: { process }, now: () => now },
      customerAccess: { authenticate, customers: {} as any } });
    apps.push(app);
    const e = event(), raw = JSON.stringify(e);
    expect((await app.inject({ method: "POST", url: path, headers: headers(raw, e.id), payload: raw })).statusCode).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
  });
  it("rejects invalid signatures, malformed envelopes, header mismatch and missing environment", async () => {
    const process = vi.fn(async () => "processed"), app = await appFor({ process }), e = event();
    const raw = JSON.stringify(e);
    expect((await app.inject({ method: "POST", url: path, headers: { ...headers(raw, e.id), "x-ozav-signature": sign(raw, t - 301) }, payload: raw })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: path, headers: headers(raw, "ozav_evt_wrong"), payload: raw })).statusCode).toBe(400);
    const unknown = JSON.stringify({ ...e, livemode: undefined });
    expect((await app.inject({ method: "POST", url: path, headers: headers(unknown, e.id), payload: unknown })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: path, headers: headers("{", e.id), payload: "{" })).statusCode).toBe(400);
    expect(process).not.toHaveBeenCalled();
  });
  it("ignores live events and refuses disabled and oversized deliveries", async () => {
    const process = vi.fn(async () => "processed"), app = await appFor({ process }), e = { ...event(), livemode: true };
    const raw = JSON.stringify(e);
    const live = await app.inject({ method: "POST", url: path, headers: headers(raw, e.id), payload: raw });
    expect(live.json().result).toBe("ignored_environment"); expect(process).not.toHaveBeenCalled();
    const disabled = await appFor();
    expect((await disabled.inject({ method: "POST", url: path, headers: headers(raw, e.id), payload: raw })).statusCode).toBe(503);
    const big = JSON.stringify({ ...e, data: { private: "x".repeat(65536) } });
    expect((await app.inject({ method: "POST", url: path, headers: headers(big, e.id), payload: big })).statusCode).toBe(413);
  });
  it("asks for retry on failure without leaking details and reports ID conflicts", async () => {
    const e = event(), raw = JSON.stringify(e);
    const process = vi.fn(async () => { throw new Error("provider secret response"); });
    const app = await appFor({ process });
    const r = await app.inject({ method: "POST", url: path, headers: headers(raw, e.id), payload: raw });
    expect(r.statusCode).toBe(503); expect(r.body).not.toContain("secret");
    process.mockImplementation(async () => { throw new CustomerWebhookConflict(); });
    expect((await app.inject({ method: "POST", url: path, headers: headers(raw, e.id), payload: raw })).statusCode).toBe(409);
  });
});

const db = new PGlite();
let failReceipt = false;
// PGlite is one embedded connection; serialize test transactions like pool clients.
let tail: Promise<void> = Promise.resolve();
const query = async (sql: string, params?: unknown[]) => {
  if (failReceipt && sql.startsWith("update peragus_customer_webhook_events")) { failReceipt = false; throw new Error("receipt write failed"); }
  const r = await db.query(sql, params); return { ...r, rowCount: r.rows.length };
};
const pool = { query, connect: async () => {
  const previous = tail; let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  await previous; return { query, release };
} } as unknown as Pool;
const links = new PostgresSandboxCustomerLinkRepository(pool), customers = new PostgresCustomerRepository(pool);
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated;");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
}, 30000);
afterAll(async () => { await db.close(); });
async function setup() {
  const owner = randomUUID();
  const actor = (await customers.createOrGet({ ownerUserId: owner, type: "pf", displayName: "Fixture" })).customer;
  const providerId = `ozav_cus_${actor.id.replaceAll("-", "")}`;
  const snapshot = { provider_status: "rejected", verification_mode: "full" as const, verification_status: "rejected",
    due_codes: ["residential_address"], due_count: 1, missing_fields_count: 9, documents_due_count: 0, requirements_pending: true };
  const getSnapshot = vi.fn(async () => snapshot);
  const provider = { getCustomerCapabilities: vi.fn(async () => ({ environment: "test" as const, entitlements: ["customers", "custody"], scopes: ["customers:read", "customers:write"] })),
    createSandboxCustomer: vi.fn(async (input: any) => ({ id: providerId, externalRef: input.externalRef, email: input.email, status: "approved", verificationMode: "full" as const })),
    getSandboxCustomerSnapshot: getSnapshot };
  await new OzavSandboxCustomerService(links, provider).execute(actor.id);
  const processor = new PostgresCustomerWebhookProcessor(pool, provider);
  return { actor, owner, providerId, provider, processor, getSnapshot, snapshot };
}
describe("transactional webhook deduplication and safe refresh", () => {
  it("refreshes current provider state rather than event approval; concurrent repeats fetch once", async () => {
    const s = await setup(), e = event(s.providerId);
    expect(await Promise.all([s.processor.process(e, digest(e)), s.processor.process(e, digest(e))])).toEqual(["processed", "duplicate"]);
    expect(s.getSnapshot).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot).toHaveBeenCalledWith(s.providerId, `peragus-sandbox:${s.actor.id}`);
    expect((await links.find(s.actor.id))?.snapshot).toEqual(s.snapshot);
    expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
    const receipt = await db.query("select * from peragus_customer_webhook_events where event_id=$1", [e.id]);
    expect(receipt.rows[0]).toMatchObject({ disposition: "processed", environment: "test" });
    expect(JSON.stringify(receipt.rows)).not.toContain("private@example.test");
  });
  it("processes a signed delivery through the HTTP route and dedupes its redelivery", async () => {
    const s = await setup(), app = await appFor(s.processor), e = event(s.providerId), raw = JSON.stringify(e);
    const first = await app.inject({ method: "POST", url: path, headers: headers(raw, e.id), payload: raw });
    expect(first.json()).toEqual({ received: true, result: "processed" });
    const second = await app.inject({ method: "POST", url: path, headers: headers(raw, e.id), payload: raw });
    expect(second.json()).toEqual({ received: true, result: "duplicate" });
    expect(s.getSnapshot).toHaveBeenCalledTimes(1);
    expect((await links.find(s.actor.id))?.snapshot?.provider_status).toBe("rejected");
  });
  it("rolls back receipt and snapshot together when completion fails, permitting retry", async () => {
    const s = await setup(), e = event(s.providerId);
    failReceipt = true;
    await expect(s.processor.process(e, digest(e))).rejects.toThrow("receipt write failed");
    expect((await links.find(s.actor.id))?.snapshot).toBeNull();
    expect((await db.query("select * from peragus_customer_webhook_events where event_id=$1", [e.id])).rows).toHaveLength(0);
    expect(await s.processor.process(e, digest(e))).toBe("processed");
    expect(s.getSnapshot).toHaveBeenCalledTimes(2);
  });
  it("leaves failed provider calls retryable and never creates bindings for foreign IDs", async () => {
    const s = await setup(), e = event(s.providerId);
    s.getSnapshot.mockRejectedValueOnce(new Error("network"));
    await expect(s.processor.process(e, digest(e))).rejects.toThrow("network");
    expect(await s.processor.process(e, digest(e))).toBe("processed");
    const foreign = event(); expect(await s.processor.process(foreign, digest(foreign))).toBe("ignored");
    expect(s.getSnapshot).toHaveBeenCalledTimes(2);
  });
  it("dedupes test/unsupported events, rejects ID collisions and never trusts out-of-order snapshots", async () => {
    const s = await setup(), old = event(s.providerId);
    old.created_at = "2026-01-01T00:00:00Z";
    expect(await s.processor.process(old, digest(old))).toBe("processed");
    expect((await links.find(s.actor.id))?.providerStatus).toBe("rejected");
    const changed = { ...old, data: {} };
    await expect(s.processor.process(changed, digest(changed))).rejects.toBeInstanceOf(CustomerWebhookConflict);
    const test = { ...event(), type: "webhook.test" };
    expect(await s.processor.process(test, digest(test))).toBe("ignored");
    expect(await s.processor.process(test, digest(test))).toBe("duplicate");
    await expect(s.processor.process({ ...event(), livemode: true }, "a".repeat(64))).rejects.toThrow();
  });
  it("retains browser-role restrictions on receipt storage", async () => {
    const r = await db.query(`select relrowsecurity, has_table_privilege('anon','peragus_customer_webhook_events','SELECT') as anon_select,
      has_table_privilege('authenticated','peragus_customer_webhook_events','INSERT') as auth_insert
      from pg_class where relname='peragus_customer_webhook_events'`);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, anon_select: false, auth_insert: false });
  });
});
