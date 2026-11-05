import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { CustomerTermsService } from "../src/onboarding/customer-terms-service.js";
import { TermsVault } from "../src/onboarding/terms-vault.js";
import { PostgresCustomerTermsRepository } from "../src/repositories/postgres-customer-terms.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { OzavClient, type OzavTermsEvidence } from "../src/providers/ozav-client.js";

const secret = "ts_secret_once_returned_123456789";
const key = randomBytes(32).toString("base64"), vault = new TermsVault(key, "v1");
const initialNow = new Date("2026-10-18T15:00:00Z"), expiresAt = "2026-10-18T16:00:00.000Z";
const pending = () => ({ token: secret, status: "pending" as const, url: "https://ozav.io/terms", version: "2.0", expiresAt, acceptedAt: null });
const caps = { environment: "test" as const, entitlements: ["customers"], scopes: ["customers:write"] };
const rawSession = () => ({ id: secret, object: "terms_session", status: "pending", terms_url: "https://ozav.io/terms", terms_version: "2.0", expires_at: expiresAt });

describe("provider terms transport and token protection", () => {
  it("sends idempotent creation and explicit acceptance without leaking a token on replay", async () => {
    const sent: any[] = [];
    const client = new OzavClient({ apiKey: "ozav_sk_test_terms", attempts: 1, writeTransport: async request => {
      sent.push(request);
      return request.path.endsWith("/accept") ? { statusCode: 200, body: { ...rawSession(), id: undefined, status: "accepted", accepted_at: request.body.accepted_at } }
        : { statusCode: 201, body: rawSession() };
    } });
    const id = `peragus-terms-${randomUUID()}`;
    expect((await client.createCustomerTerms(id)).token).toBe(secret);
    const evidence = { accepted_by: { legal_name: "Pessoa Sintetica" }, accepted_at: initialNow.toISOString() };
    expect((await client.acceptCustomerTerms(secret, evidence)).status).toBe("accepted");
    expect(sent[0]).toMatchObject({ path: "/v2/customers/terms-sessions", body: {}, idempotencyKey: id });
    expect(sent[1].body).toEqual({ terms_session_id: secret, ...evidence });
    expect(sent[1].body.ip_address).toBeUndefined();
    const replay = new OzavClient({ apiKey: "ozav_sk_test_terms", attempts: 1, writeTransport: async () => ({ statusCode: 200, body: { ...rawSession(), id: undefined } }) });
    expect((await replay.createCustomerTerms(id)).token).toBeNull();
  });
  it.each(["https://evil.example/terms", "javascript:alert(1)", "https://ozav.io/terms?token=secret"])("rejects an untrusted terms URL %s", async terms_url => {
    const client = new OzavClient({ apiKey: "ozav_sk_test_terms", attempts: 1, writeTransport: async () => ({ statusCode: 201, body: { ...rawSession(), terms_url } }) });
    await expect(client.createCustomerTerms(`peragus-terms-${randomUUID()}`)).rejects.toThrow();
  });
  it("separates token and evidence purposes and authenticates customer/session/version metadata", () => {
    const context = { id: randomUUID(), customerId: randomUUID(), termsUrl: "https://ozav.io/terms", termsVersion: "2.0", expiresAt };
    const sealed = vault.seal(context, "token", { token: secret });
    expect(vault.open(context, "token", sealed)).toEqual({ token: secret });
    expect(() => vault.open(context, "acceptance", sealed)).toThrow();
    expect(() => vault.open({ ...context, customerId: randomUUID() }, "token", sealed)).toThrow();
    expect(() => vault.open({ ...context, termsVersion: "other" }, "token", sealed)).toThrow();
    expect(JSON.stringify(sealed)).not.toContain(secret);
  });
});

const db = new PGlite();
let failCreation = false, failAcceptance = false;
let tail: Promise<void> = Promise.resolve();
const query = async (sql: string, params?: unknown[]) => {
  if (failCreation && sql.includes("set state='ready'")) { failCreation = false; throw new Error("DB creation failure"); }
  if (failAcceptance && sql.includes("set state='accepted'")) { failAcceptance = false; throw new Error("DB acceptance failure"); }
  const r = await db.query(sql, params); return { ...r, rowCount: r.rows.length };
};
const pool = { query, connect: async () => {
  const prior = tail; let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; }); await prior;
  return { query, release };
} } as unknown as Pool;
const repo = new PostgresCustomerTermsRepository(pool), customers = new PostgresCustomerRepository(pool);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
}, 30000);
afterAll(async () => { await Promise.all(apps.map(app => app.close())); await db.close(); });
async function setup(type: "pf" | "pj" = "pf") {
  const owner = randomUUID(), actor = (await customers.createOrGet({ ownerUserId: owner, type, displayName: "Local test" })).customer;
  let now = initialNow, name = "Pessoa Sintetica", hasDraft = true;
  const provider = { getCustomerCapabilities: vi.fn(async () => caps), createCustomerTerms: vi.fn(async () => pending()),
    acceptCustomerTerms: vi.fn(async (_token: string, evidence: OzavTermsEvidence) => ({ ...pending(), token: null, status: "accepted" as const, acceptedAt: evidence.accepted_at })) };
  const drafts = { read: vi.fn(async () => hasDraft ? { individual: { legal_name: name }, version: 1 } : null) };
  const service = new CustomerTermsService(repo, vault, provider, drafts as any, () => now);
  return { owner, actor, provider, drafts, service, advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    rename: (value: string) => { name = value; }, withoutDraft: () => { hasDraft = false; } };
}
const path = "/v1/me/onboarding/terms", headers = { authorization: "Bearer valid" };
async function appFor(s: Awaited<ReturnType<typeof setup>>, enabled = true, output?: Writable) {
  const app = await buildApp({ customerAccess: { customers, authenticate: async token => {
    if (token !== "valid") throw new AuthenticationError("INVALID_TOKEN"); return { id: s.owner, email: "private@example.test" };
  } }, ...(enabled ? { customerTermsService: s.service } : {}), ...(output ? { logger: { level: "debug", stream: output } } : {}) });
  apps.push(app); return app;
}
describe("owned terms sessions and explicit acceptance", () => {
  it("creates/reuses without implicit acceptance, exposes only local IDs and keeps local approval unchanged", async () => {
    const s = await setup(), app = await appFor(s);
    expect((await app.inject({ method: "GET", url: path, headers })).json().data).toBeNull();
    const first = await app.inject({ method: "POST", url: path, headers, payload: {} });
    expect(first.statusCode).toBe(201); expect(first.json().data).toMatchObject({ state: "ready", terms_url: "https://ozav.io/terms", can_accept: true, operations_enabled: false });
    expect(first.body).not.toContain(secret); expect(s.provider.acceptCustomerTerms).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: path, headers, payload: {} })).statusCode).toBe(200);
    expect(s.provider.createCustomerTerms).toHaveBeenCalledTimes(1);
    const accepted = await app.inject({ method: "POST", url: `${path}/accept`, headers, payload: { session_id: first.json().data.session_id, accepted: true } });
    expect(accepted.statusCode).toBe(200); expect(accepted.json().data.state).toBe("accepted"); expect(accepted.body).not.toContain(secret);
    expect((await s.service.accept(s.actor.id, first.json().data.session_id)).state).toBe("accepted");
    expect(s.provider.acceptCustomerTerms).toHaveBeenCalledTimes(1);
    expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
    expect((await app.inject({ method: "POST", url: "/v1/settlements", headers, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/me/onboarding/individual", headers })).statusCode).toBe(503);
    const stored = await db.query("select * from peragus_customer_terms_sessions where customer_id=$1", [s.actor.id]);
    expect(JSON.stringify(stored.rows)).not.toContain(secret); expect(JSON.stringify(stored.rows)).not.toContain("Pessoa Sintetica");
  });
  it("requires explicit true and rejects supplied identities, timestamps and foreign session IDs", async () => {
    const s = await setup(), other = await setup(), app = await appFor(s);
    const session = await s.service.start(s.actor.id), id = session.data.session_id;
    for (const payload of [{ session_id: id }, { session_id: id, accepted: false }, { session_id: id, accepted: true, accepted_at: initialNow.toISOString() }, { session_id: id, accepted: true, accepted_by: { legal_name: "Other" } }]) {
      expect((await app.inject({ method: "POST", url: `${path}/accept`, headers, payload })).statusCode).toBe(400);
    }
    await expect(other.service.accept(other.actor.id, id)).rejects.toThrow("TERMS_SESSION_NOT_FOUND");
    expect((await (await appFor(other)).inject({ method: "GET", url: `${path}?customer_id=${s.actor.id}`, headers })).json().data).toBeNull();
    expect(s.provider.acceptCustomerTerms).not.toHaveBeenCalled();
  });
  it("requires a saved PF draft before acceptance", async () => {
    const s = await setup(), session = await s.service.start(s.actor.id); s.withoutDraft();
    await expect(s.service.accept(s.actor.id, session.data.session_id)).rejects.toThrow("TERMS_PROFILE_REQUIRED");
    expect(s.provider.acceptCustomerTerms).not.toHaveBeenCalled();
  });
  it("freezes evidence across uncertain acceptance, draft edits and persistence failure", async () => {
    const s = await setup(), session = await s.service.start(s.actor.id);
    failAcceptance = true;
    await expect(s.service.accept(s.actor.id, session.data.session_id)).rejects.toThrow("DB acceptance failure");
    expect((await repo.findActive(s.actor.id))?.state).toBe("accepting");
    s.rename("Edited after original click");
    await expect(s.service.accept(s.actor.id, session.data.session_id)).rejects.toThrow("TERMS_PROCESSING");
    s.advance(31000);
    expect((await s.service.accept(s.actor.id, session.data.session_id)).state).toBe("accepted");
    expect(s.provider.acceptCustomerTerms.mock.calls[0]).toEqual(s.provider.acceptCustomerTerms.mock.calls[1]);
    expect(s.provider.acceptCustomerTerms.mock.calls[1]![1].accepted_by.legal_name).toBe("Pessoa Sintetica");
    expect(s.provider.acceptCustomerTerms.mock.calls[1]![1].accepted_at).toBe(initialNow.toISOString());
  });
  it("does not reissue a one-time token by retry; requires explicit renewal and preserves history", async () => {
    const s = await setup(); failCreation = true;
    await expect(s.service.start(s.actor.id)).rejects.toThrow("DB creation failure");
    const original = (await repo.findActive(s.actor.id))!;
    await expect(s.service.start(s.actor.id)).rejects.toThrow("TERMS_PROCESSING");
    s.advance(31000); s.provider.createCustomerTerms.mockResolvedValueOnce({ ...pending(), token: null } as any);
    await expect(s.service.start(s.actor.id)).rejects.toThrow("TERMS_RECOVERY_REQUIRED");
    expect(s.provider.createCustomerTerms.mock.calls[0]).toEqual(s.provider.createCustomerTerms.mock.calls[1]);
    await expect(s.service.start(s.actor.id)).rejects.toThrow("TERMS_RECOVERY_REQUIRED");
    const fresh = await s.service.start(s.actor.id, original.id);
    expect(fresh.data.session_id).not.toBe(original.id);
    expect((await repo.findOwned(s.actor.id, original.id))?.active).toBe(false);
    expect(s.provider.createCustomerTerms.mock.calls[2]![0]).not.toBe(s.provider.createCustomerTerms.mock.calls[0]![0]);
  });
  it("blocks acceptance of expired sessions and permits explicit renewal", async () => {
    const s = await setup(), session = await s.service.start(s.actor.id); s.advance(3600001);
    await expect(s.service.accept(s.actor.id, session.data.session_id)).rejects.toThrow("TERMS_SESSION_EXPIRED");
    expect((await s.service.read(s.actor.id))?.can_renew).toBe(true);
    s.provider.createCustomerTerms.mockResolvedValueOnce({ ...pending(), expiresAt: "2026-10-18T18:00:00.000Z" });
    expect((await s.service.start(s.actor.id, session.data.session_id)).created).toBe(true);
  });
  it("fails closed on capability denial and contradictory acceptance response", async () => {
    const s = await setup(); s.provider.getCustomerCapabilities.mockResolvedValueOnce({ ...caps, scopes: [] });
    await expect(s.service.start(s.actor.id)).rejects.toThrow("TERMS_CAPABILITY_REQUIRED");
    expect(s.provider.createCustomerTerms).not.toHaveBeenCalled();
    const b = await setup(), session = await b.service.start(b.actor.id);
    b.provider.acceptCustomerTerms.mockResolvedValueOnce({ ...pending(), token: null, status: "accepted", acceptedAt: "2026-10-17T00:00:00.000Z" });
    await expect(b.service.accept(b.actor.id, session.data.session_id)).rejects.toThrow("TERMS_RESPONSE_CONFLICT");
    expect((await repo.findActive(b.actor.id))?.state).toBe("accepting");
  });
  it("blocks PJ, suspension, missing authentication and disabled routes without exposing parser input", async () => {
    const s = await setup(), pj = await setup("pj"); let logs = "";
    const output = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
    const app = await appFor(s, true, output);
    expect((await app.inject({ method: "POST", url: path, payload: {} })).statusCode).toBe(401);
    expect((await (await appFor(pj)).inject({ method: "POST", url: path, headers, payload: {} })).statusCode).toBe(403);
    expect((await (await appFor(s, false)).inject({ method: "GET", url: path, headers })).statusCode).toBe(503);
    const invalid = await app.inject({ method: "POST", url: `${path}/accept`, headers: { ...headers, "content-type": "application/json" }, payload: `"${secret}" INVALID` });
    expect(invalid.statusCode).toBe(400); expect(invalid.body).not.toContain(secret); expect(logs).not.toContain(secret);
    await db.query("update peragus_customers set suspended=true where id=$1", [s.actor.id]);
    expect((await app.inject({ method: "GET", url: path, headers })).statusCode).toBe(403);
  });
  it("enforces test environment, active uniqueness and browser restrictions", async () => {
    const s = await setup(); await s.service.start(s.actor.id);
    await expect(db.query("update peragus_customer_terms_sessions set environment='live' where customer_id=$1", [s.actor.id])).rejects.toThrow();
    const r = await db.query(`select relrowsecurity, has_table_privilege('anon','peragus_customer_terms_sessions','SELECT') as anon_select,
      has_table_privilege('authenticated','peragus_customer_terms_sessions','INSERT') as auth_insert
      from pg_class where relname='peragus_customer_terms_sessions'`);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, anon_select: false, auth_insert: false });
  });
});
