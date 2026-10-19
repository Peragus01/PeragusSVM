import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { DraftCipher } from "../src/onboarding/draft-cipher.js";
import { individualDraftSchema } from "../src/onboarding/individual-schema.js";
import { IndividualDraftService } from "../src/onboarding/individual-draft-service.js";
import { TermsVault } from "../src/onboarding/terms-vault.js";
import { CustomerTermsService } from "../src/onboarding/customer-terms-service.js";
import { CustomerSubmissionService } from "../src/onboarding/customer-submission-service.js";
import { SubmissionVault } from "../src/onboarding/submission-vault.js";
import { PostgresOnboardingSubmissionRepository } from "../src/repositories/postgres-onboarding-submission.js";
import { PostgresCustomerTermsRepository } from "../src/repositories/postgres-customer-terms.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { PostgresIndividualDraftRepository } from "../src/repositories/postgres-individual-draft.js";
import { PostgresCustomerWebhookProcessor } from "../src/repositories/postgres-customer-webhook.js";
import { OzavClient, type OzavWriteRequest } from "../src/providers/ozav-client.js";

const db = new PGlite();
let failCompletion = false, failReceipt = false;
let tail: Promise<void> = Promise.resolve();
const query = async (sql: string, params?: unknown[]) => {
  if (failCompletion && sql.includes("set state='linked'")) { failCompletion = false; throw new Error("local completion failed"); }
  if (failReceipt && sql.startsWith("update peragus_customer_webhook_events")) { failReceipt = false; throw new Error("receipt failed"); }
  const r = await db.query(sql, params); return { ...r, rowCount: r.rows.length };
};
const pool = { query, connect: async () => { const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await previous; return { query, release }; } } as unknown as Pool;
const key = randomBytes(32).toString("base64"), termsVault = new TermsVault(key, "v1"), submissionVault = new SubmissionVault(key, "v1");
const customers = new PostgresCustomerRepository(pool), repo = new PostgresOnboardingSubmissionRepository(pool), termsRepo = new PostgresCustomerTermsRepository(pool);
const drafts = new IndividualDraftService(new PostgresIndividualDraftRepository(pool), new DraftCipher(key, "v1"));
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const fixedNow = new Date("2026-10-18T18:00:00Z"), expiresAt = "2026-10-19T16:12:34.882Z", token = "ts_secret_submission_token_once_123456";
const fixture = () => individualDraftSchema(fixedNow).parse({ legal_name: "Pessoa Sintetica", cpf: "52998224725", date_of_birth: "1990-01-01", nationality: "BR",
  phone: { country_code: "+55", number: "11999999999" }, residential_address: { line1: "Rua Teste", number: "1", neighborhood: "Bairro", city: "Cidade", state: "SP", postal_code: "01001000", country: "BR" },
  source_of_funds: "Dados sinteticos", monthly_income_usd: 0, expected_monthly_volume_usd: 10 });
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
}, 30000);
afterAll(async () => { await Promise.all(apps.map(app => app.close())); await db.close(); });
async function setup(type: "pf" | "pj" = "pf") {
  const owner = randomUUID(), actor = (await customers.createOrGet({ ownerUserId: owner, type, displayName: "Local test" })).customer;
  await drafts.save(actor.id, 0, fixture());
  const termsId = randomUUID(), context = { id: termsId, customerId: actor.id, termsUrl: "https://ozav.io/terms", termsVersion: "2.0", expiresAt };
  const evidence = { accepted_by: { legal_name: fixture().legal_name }, accepted_at: fixedNow.toISOString() };
  await db.query(`insert into peragus_customer_terms_sessions
    (id,customer_id,state,idempotency_key,lease_until,encrypted_token,terms_url,terms_version,expires_at,encrypted_acceptance,accepted_at)
    values($1,$2,'accepted',$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10)`,
    [termsId, actor.id, randomUUID(), fixedNow.toISOString(), JSON.stringify(termsVault.seal(context,"token",{token})), context.termsUrl,context.termsVersion,expiresAt,
      JSON.stringify(termsVault.seal(context,"acceptance",evidence)),evidence.accepted_at]);
  let now = fixedNow, writeError: number | null = null, failNetwork = false, resultMode = "full", status = "approved", externalId = `ozav_cus_form${actor.id.replaceAll("-", "")}`;
  const caps = { environment: "test", entitlements: ["customers", "custody"], scopes: ["customers:write", "customers:read"] };
  const writeTransport = vi.fn(async (r: OzavWriteRequest) => {
    if (failNetwork) { failNetwork = false; throw new Error("secret network response"); }
    if (writeError) return { statusCode: writeError, body: { error: { code: "CUSTOMER_ALREADY_EXISTS", details: { id: "secret-other-id", email: "private@example.test" } } } };
    return { statusCode: 201, body: { id: externalId, object: "customer", type: "individual", email: r.body.email,
      external_ref: r.body.external_ref, status, verification: { mode: resultMode } } };
  });
  const transport = vi.fn(async (path: string) => path === "/v2/capabilities" ? { statusCode: 200, body: caps } : { statusCode: 200, body: {
    id: externalId, object: "customer", type: "individual", external_ref: `peragus-onboarding-test:${actor.id}`,
    status, verification: { mode: "full", status }, requirements: { due: ["private address"], due_codes: ["residential_address"], missing_fields: ["private"], documents_due: [] },
  } });
  const provider = new OzavClient({ apiKey: "ozav_sk_test_registration", attempts: 1, transport, writeTransport });
  const terms = new CustomerTermsService(termsRepo, termsVault, provider, drafts, () => now);
  const service = new CustomerSubmissionService(repo, submissionVault, drafts, terms, provider);
  return { actor, owner, termsId, context, caps, provider, service, terms, transport, writeTransport,
    networkFailure: () => { failNetwork = true; }, setError: (value: number | null) => { writeError = value; }, setMode: (value: string) => { resultMode = value; },
    setStatus: (value: string) => { status = value; }, setId: (value: string) => { externalId = value; }, getId: () => externalId, advance: () => { now = new Date("2026-10-21T00:00:00Z"); } };
}
const path = "/v1/me/onboarding", headers = { authorization: "Bearer valid" };
async function appFor(s: Awaited<ReturnType<typeof setup>>, enabled = true) {
  const app = await buildApp({ customerAccess: { customers, authenticate: async value => {
    if (value !== "valid") throw new AuthenticationError("INVALID_TOKEN"); return { id: s.owner, email: "actual-user-private@example.test" };
  } }, ...(enabled ? { customerSubmissionService: s.service } : {}) });
  apps.push(app); return app;
}
const bodyFor = (s: Awaited<ReturnType<typeof setup>>) => ({ draft_version: 1, terms_session_id: s.termsId, sandbox_data_confirmed: true });
describe("form registration from encrypted draft and accepted terms", () => {
  it("submits/replays one separate binding, protects persisted payload and never approves the local customer", async () => {
    const s = await setup(), app = await appFor(s);
    expect((await app.inject({ method: "GET", url: path, headers })).json().data).toBeNull();
    const first = await app.inject({ method: "POST", url: `${path}/submit`, headers, payload: bodyFor(s) });
    expect(first.statusCode).toBe(201); expect(first.json().data).toMatchObject({ sandbox_submission: true, state: "linked", provider_customer_id: s.getId(), operations_enabled: false });
    const replay = await app.inject({ method: "POST", url: `${path}/submit`, headers, payload: bodyFor(s) });
    expect(replay.statusCode).toBe(200); expect(replay.json().meta.idempotent_replay).toBe(true); expect(s.writeTransport).toHaveBeenCalledTimes(1);
    const sent = s.writeTransport.mock.calls[0]![0];
    expect(sent.body).toMatchObject({ verification_mode: "full", custody_model: "managed", terms_session_id: token,
      individual: { tax_id: { country: "BR", type: "cpf", value: "52998224725" }, monthly_income_usd: 0 } });
    expect(sent.body.email).toBe(`peragus-onboarding-test-${s.actor.id}@example.com`);
    expect(JSON.stringify(sent)).not.toContain("actual-user-private"); expect(first.body).not.toContain(token); expect(first.body).not.toContain("52998224725");
    const stored = await db.query("select * from peragus_customer_onboarding_submissions where customer_id=$1", [s.actor.id]);
    for (const secret of [token, "52998224725", "Pessoa Sintetica", "Rua Teste"]) expect(JSON.stringify(stored.rows)).not.toContain(secret);
    expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
    expect((await app.inject({ method: "POST", url: "/v1/settlements", headers, payload: {} })).statusCode).toBe(403);
    expect((await db.query("select * from peragus_ozav_sandbox_customer_links where customer_id=$1", [s.actor.id])).rows).toHaveLength(0);
  });
  it("requires a current draft and accepted owned unexpired terms with the same legal name", async () => {
    const absent = await setup(); await db.query("delete from peragus_individual_onboarding_drafts where customer_id=$1", [absent.actor.id]);
    await expect(absent.service.submit(absent.actor.id, 1, absent.termsId)).rejects.toThrow("ONBOARDING_DRAFT_REQUIRED");
    const changed = await setup(); await drafts.save(changed.actor.id, 1, { ...fixture(), legal_name: "Nome alterado" });
    await expect(changed.service.submit(changed.actor.id, 1, changed.termsId)).rejects.toThrow("ONBOARDING_DRAFT_CHANGED");
    await expect(changed.service.submit(changed.actor.id, 2, changed.termsId)).rejects.toThrow("TERMS_RESPONSE_CONFLICT");
    const expired = await setup(); expired.advance();
    await expect(expired.service.submit(expired.actor.id, 1, expired.termsId)).rejects.toThrow("TERMS_SESSION_EXPIRED");
    const pending = await setup(); await db.query("update peragus_customer_terms_sessions set state='ready' where id=$1", [pending.termsId]);
    await expect(pending.service.submit(pending.actor.id, 1, pending.termsId)).rejects.toThrow("TERMS_SESSION_NOT_FOUND");
    const foreign = await setup(); await expect(foreign.service.submit(foreign.actor.id, 1, pending.termsId)).rejects.toThrow("TERMS_SESSION_NOT_FOUND");
    for (const s of [absent, changed, expired, pending, foreign]) expect(s.writeTransport).not.toHaveBeenCalled();
  });
  it("retries the frozen body/key after timeout, edits and expiration without creating another logical request", async () => {
    const s = await setup(); s.networkFailure();
    await expect(s.service.submit(s.actor.id, 1, s.termsId)).rejects.toThrow("OZAV connection failed");
    expect((await repo.find(s.actor.id))?.state).toBe("pending");
    await drafts.save(s.actor.id, 1, { ...fixture(), legal_name: "Edited after send" }); s.advance();
    expect((await s.service.submit(s.actor.id, 1, s.termsId)).data?.state).toBe("linked");
    expect(s.writeTransport.mock.calls[0]![0]).toEqual(s.writeTransport.mock.calls[1]![0]);
    await expect(s.service.submit(s.actor.id, 2, s.termsId)).rejects.toThrow("ONBOARDING_CONFLICT");
  });
  it("recovers local completion failure with the same original provider request", async () => {
    const s = await setup(); failCompletion = true;
    await expect(s.service.submit(s.actor.id, 1, s.termsId)).rejects.toThrow("local completion failed");
    expect((await s.service.submit(s.actor.id, 1, s.termsId)).data?.state).toBe("linked");
    expect(s.writeTransport.mock.calls[0]![0]).toEqual(s.writeTransport.mock.calls[1]![0]);
  });
  it("does not adopt provider duplicates or diagnostic fixture IDs and rejects reliance", async () => {
    const duplicate = await setup(), app = await appFor(duplicate); duplicate.setError(409);
    const response = await app.inject({ method: "POST", url: `${path}/submit`, headers, payload: bodyFor(duplicate) });
    expect(response.statusCode).toBe(502); expect(response.json().error.automatic_linking).toBe(false); expect(response.body).not.toContain("private@example.test");
    expect((await repo.find(duplicate.actor.id))?.state).toBe("pending");
    const reliance = await setup(); reliance.setMode("reliance");
    await expect(reliance.service.submit(reliance.actor.id, 1, reliance.termsId)).rejects.toThrow();
    const fixtureId = await setup();
    await db.query(`insert into peragus_ozav_sandbox_customer_links(customer_id,idempotency_key,request_hash,state,ozav_customer_id)
      values($1,$2,$3,'linked',$4)`, [fixtureId.actor.id, randomUUID(), "a".repeat(64), fixtureId.getId()]);
    await expect(fixtureId.service.submit(fixtureId.actor.id, 1, fixtureId.termsId)).rejects.toThrow("ONBOARDING_CONFLICT");
  });
  it("requires explicit synthetic confirmation and isolates owners, PJ, suspended, disabled and anonymous callers", async () => {
    const s = await setup(), other = await setup(), pj = await setup("pj"), app = await appFor(s);
    expect((await app.inject({ method: "POST", url: `${path}/submit`, headers, payload: { draft_version: 1, terms_session_id: s.termsId } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${path}/submit`, headers, payload: { ...bodyFor(s), customer_id: other.actor.id } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${path}/submit`, payload: bodyFor(s) })).statusCode).toBe(401);
    expect((await (await appFor(pj)).inject({ method: "POST", url: `${path}/submit`, headers, payload: bodyFor(pj) })).statusCode).toBe(403);
    expect((await (await appFor(s, false)).inject({ method: "GET", url: path, headers })).statusCode).toBe(503);
    await s.service.submit(s.actor.id, 1, s.termsId);
    expect((await (await appFor(other)).inject({ method: "GET", url: `${path}?customer_id=${s.actor.id}`, headers })).json().data).toBeNull();
    await db.query("update peragus_customers set suspended=true where id=$1", [s.actor.id]);
    expect((await app.inject({ method: "GET", url: path, headers })).statusCode).toBe(403);
  });
  it("refreshes the submitted binding through the signed-event processor and atomically rolls back failures", async () => {
    const s = await setup(); await s.service.submit(s.actor.id, 1, s.termsId); s.setStatus("rejected");
    const processor = new PostgresCustomerWebhookProcessor(pool, s.provider);
    const e = { id: `ozav_evt_${randomUUID().replaceAll("-", "")}`, object: "event" as const, type: "customer.updated", livemode: false, created_at: fixedNow.toISOString(), data: { customer: { id: s.getId(), status: "approved" } } };
    const hash = createHash("sha256").update(JSON.stringify(e)).digest("hex");
    failReceipt = true; await expect(processor.process(e, hash)).rejects.toThrow("receipt failed");
    expect((await repo.find(s.actor.id))?.snapshot).toBeNull();
    expect(await processor.process(e, hash)).toBe("processed");
    expect(await processor.process(e, hash)).toBe("duplicate");
    expect((await repo.find(s.actor.id))?.snapshot).toMatchObject({ provider_status: "rejected", requirements_pending: true });
    expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
  });
  it("protects ciphertext context and rejects stale snapshot writes and missing capabilities", async () => {
    const s = await setup(); s.networkFailure(); await expect(s.service.submit(s.actor.id, 1, s.termsId)).rejects.toThrow();
    const stored = (await repo.find(s.actor.id))!;
    const context = { id: stored.id, customerId: stored.customerId, draftVersion: stored.draftVersion, termsSessionId: stored.termsSessionId };
    expect(() => submissionVault.open({ ...context, customerId: randomUUID() }, stored.encryptedPayload)).toThrow();
    expect(() => submissionVault.open({ ...context, draftVersion: 2 }, stored.encryptedPayload)).toThrow();
    const missing = await setup(); missing.caps.entitlements = ["customers"];
    await expect(missing.service.submit(missing.actor.id, 1, missing.termsId)).rejects.toThrow("ONBOARDING_CAPABILITY_REQUIRED");
    expect(missing.writeTransport).not.toHaveBeenCalled();
    await s.service.submit(s.actor.id, 1, s.termsId); await s.service.refresh(s.actor.id);
    const row = (await repo.find(s.actor.id))!;
    await expect(repo.saveSnapshot(s.actor.id, row.providerId!, 0, row.snapshot!)).rejects.toThrow("ONBOARDING_CONFLICT");
  });
  it("retains test-only rows and revokes browser access", async () => {
    const r = await db.query(`select relrowsecurity, has_table_privilege('anon','peragus_customer_onboarding_submissions','SELECT') as anon_select,
      has_table_privilege('authenticated','peragus_customer_onboarding_submissions','INSERT') as auth_insert
      from pg_class where relname='peragus_customer_onboarding_submissions'`);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, anon_select: false, auth_insert: false });
    const s = await setup(); await s.service.submit(s.actor.id, 1, s.termsId);
    await expect(db.query("update peragus_customer_onboarding_submissions set environment='live' where customer_id=$1", [s.actor.id])).rejects.toThrow();
  });
});
