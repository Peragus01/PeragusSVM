import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Writable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { DraftCipher } from "../src/onboarding/draft-cipher.js";
import { IndividualDraftService } from "../src/onboarding/individual-draft-service.js";
import { individualDraftSchema } from "../src/onboarding/individual-schema.js";
import { PostgresIndividualDraftRepository } from "../src/repositories/postgres-individual-draft.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";

const fixture = () => ({ legal_name: "Pessoa Sintetica Teste", cpf: "529.982.247-25", date_of_birth: "1990-01-01", nationality: "BR",
  phone: { country_code: "55", number: "11999999999" }, residential_address: { line1: "Rua de Teste", number: "1", neighborhood: "Bairro Teste", city: "Cidade Teste", state: "SP", postal_code: "01001-000", country: "BR" },
  source_of_funds: "Dados sinteticos", monthly_income_usd: 0, expected_monthly_volume_usd: 10,
});
const key = randomBytes(32).toString("base64"), cipher = new DraftCipher(key, "test-v1");
const clock = new Date("2026-10-18T15:00:00Z");
describe("PF draft schema and encryption", () => {
  it("normalizes identifiers and phone, accepts declared zero and leaves optional declarations absent", () => {
    const parsed = individualDraftSchema(clock).parse(fixture());
    expect(parsed.cpf).toBe("52998224725"); expect(parsed.phone.country_code).toBe("+55");
    expect(parsed.residential_address.postal_code).toBe("01001000");
    expect(parsed.monthly_income_usd).toBe(0); expect(parsed.is_pep).toBeUndefined();
  });
  it.each(["00000000000", "52998224724", "abc52998224725"])("rejects invalid CPF %s", cpf => {
    expect(individualDraftSchema(clock).safeParse({ ...fixture(), cpf }).success).toBe(false);
  });
  it.each(["2026-01-01", "2008-10-19", "1905-10-18", "1990-02-30", "2030-01-01"])("rejects invalid age/date %s", date_of_birth => {
    expect(individualDraftSchema(clock).safeParse({ ...fixture(), date_of_birth }).success).toBe(false);
  });
  it("uses the Brazilian date at the 18-year boundary", () => {
    const input = { ...fixture(), date_of_birth: "2008-10-18" };
    expect(individualDraftSchema(new Date("2026-10-18T01:00:00Z")).safeParse(input).success).toBe(false);
    expect(individualDraftSchema(new Date("2026-10-18T03:00:00Z")).safeParse(input).success).toBe(true);
  });
  it("rejects foreign address, extra control fields and nonnumeric economic declarations", () => {
    const schema = individualDraftSchema(clock);
    expect(schema.safeParse({ ...fixture(), customer_id: randomUUID() }).success).toBe(false);
    expect(schema.safeParse({ ...fixture(), email: "other@example.test" }).success).toBe(false);
    expect(schema.safeParse({ ...fixture(), monthly_income_usd: "10" }).success).toBe(false);
    expect(schema.safeParse({ ...fixture(), expected_monthly_volume_usd: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...fixture(), residential_address: { ...fixture().residential_address, country: "US" } }).success).toBe(false);
  });
  it("encrypts with unique nonces and authenticates customer, version, key and ciphertext", () => {
    const input = individualDraftSchema(clock).parse(fixture()), id = randomUUID();
    const one = cipher.encrypt(id, 1, input), two = cipher.encrypt(id, 1, input);
    expect(one.iv).not.toBe(two.iv); expect(JSON.stringify(one)).not.toContain(input.cpf);
    expect(cipher.decrypt(id, 1, one)).toEqual(input);
    expect(() => cipher.decrypt(randomUUID(), 1, one)).toThrow();
    expect(() => cipher.decrypt(id, 2, one)).toThrow();
    expect(() => new DraftCipher(randomBytes(32).toString("base64"), "test-v1").decrypt(id, 1, one)).toThrow();
    expect(() => cipher.decrypt(id, 1, { ...one, key_id: "other" })).toThrow();
    const tampered = Buffer.from(one.ciphertext, "base64"); tampered[0] = tampered[0]! ^ 1;
    expect(() => cipher.decrypt(id, 1, { ...one, ciphertext: tampered.toString("base64") })).toThrow();
    expect(() => new DraftCipher("not-base64", "test-v1")).toThrow();
    expect(() => new DraftCipher(randomBytes(16).toString("base64"), "test-v1")).toThrow();
  });
});

const db = new PGlite();
const pool = { query: async (sql: string, params?: unknown[]) => { const r = await db.query(sql, params); return { ...r, rowCount: r.rows.length }; } } as unknown as Pool;
const customers = new PostgresCustomerRepository(pool), drafts = new PostgresIndividualDraftRepository(pool), service = new IndividualDraftService(drafts, cipher);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { authorization: "Bearer valid" }, path = "/v1/me/onboarding/individual";
async function profile(type: "pf" | "pj" = "pf") {
  const owner = randomUUID(), customer = (await customers.createOrGet({ ownerUserId: owner, type, displayName: "Local test" })).customer;
  return { owner, customer };
}
async function appFor(actor: Awaited<ReturnType<typeof profile>>, enabled = true, logging?: Writable) {
  const app = await buildApp({ customerAccess: { customers, authenticate: async token => {
    if (token !== "valid") throw new AuthenticationError("INVALID_TOKEN");
    return { id: actor.owner, email: "confirmed@example.test" };
  } }, ...(enabled ? { individualDraftService: service } : {}), ...(logging ? { logger: { level: "debug", stream: logging } } : {}) });
  apps.push(app); return app;
}
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon, authenticated;");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
}, 30000);
afterAll(async () => { await Promise.all(apps.map(app => app.close())); await db.close(); });
describe("owned encrypted PF drafts", () => {
  it("creates, reads and updates encrypted data without profile approval or provider submission", async () => {
    const actor = await profile(), app = await appFor(actor);
    expect((await app.inject({ method: "GET", url: path, headers })).json().data).toBeNull();
    const first = await app.inject({ method: "PUT", url: path, headers, payload: { expected_version: 0, individual: fixture() } });
    expect(first.statusCode).toBe(201); expect(first.json().data.version).toBe(1);
    expect(first.json().meta).toMatchObject({ draft_only: true, provider_submitted: false, operations_enabled: false });
    const raw = await db.query("select * from peragus_individual_onboarding_drafts where customer_id=$1", [actor.customer.id]);
    const serialized = JSON.stringify(raw.rows);
    for (const secret of ["Pessoa Sintetica Teste", "52998224725", "Rua de Teste", "1990-01-01", "11999999999"]) expect(serialized).not.toContain(secret);
    const read = await app.inject({ method: "GET", url: path, headers });
    expect(read.headers["cache-control"]).toBe("no-store"); expect(read.json().data.individual.cpf).toBe("52998224725");
    const update = await app.inject({ method: "PUT", url: path, headers, payload: { expected_version: 1, individual: { ...fixture(), legal_name: "Pessoa Teste Atualizada" } } });
    expect(update.statusCode).toBe(200); expect(update.json().data.version).toBe(2);
    expect((await customers.findByOwner(actor.owner))?.verificationStatus).toBe("draft");
    expect((await app.inject({ method: "POST", url: "/v1/settlements", headers, payload: {} })).statusCode).toBe(403);
    expect((await db.query("select * from peragus_ozav_sandbox_customer_links where customer_id=$1", [actor.customer.id])).rows).toHaveLength(0);
  });
  it("rejects stale writes and duplicate initial creation without changing the existing draft", async () => {
    const actor = await profile(), app = await appFor(actor), payload = { expected_version: 0, individual: fixture() };
    expect((await app.inject({ method: "PUT", url: path, headers, payload })).statusCode).toBe(201);
    expect((await app.inject({ method: "PUT", url: path, headers, payload })).statusCode).toBe(409);
    const results = await Promise.all([1, 2].map(n => app.inject({ method: "PUT", url: path, headers, payload: { expected_version: 1, individual: { ...fixture(), legal_name: `Teste ${n}` } } })));
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await service.read(actor.customer.id))?.version).toBe(2);
  });
  it("isolates owners and rejects spoofing, unauthenticated, PJ, suspended and disabled calls", async () => {
    const a = await profile(), b = await profile(), pj = await profile("pj");
    await service.save(a.customer.id, 0, individualDraftSchema(clock).parse(fixture()));
    const app = await appFor(b);
    expect((await app.inject({ method: "GET", url: `${path}?customer_id=${a.customer.id}`, headers })).json().data).toBeNull();
    expect((await app.inject({ method: "PUT", url: path, headers, payload: { expected_version: 0, customer_id: a.customer.id, individual: fixture() } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
    expect((await (await appFor(pj)).inject({ method: "GET", url: path, headers })).statusCode).toBe(403);
    expect((await (await appFor(b, false)).inject({ method: "GET", url: path, headers })).statusCode).toBe(503);
    await db.query("update peragus_customers set suspended=true where id=$1", [b.customer.id]);
    expect((await app.inject({ method: "GET", url: path, headers })).statusCode).toBe(403);
  });
  it("fails closed on swapped ciphertext and wrong keys without leaking sensitive parser errors", async () => {
    const a = await profile(), b = await profile();
    await service.save(a.customer.id, 0, individualDraftSchema(clock).parse(fixture()));
    await service.save(b.customer.id, 0, individualDraftSchema(clock).parse(fixture()));
    await db.query("update peragus_individual_onboarding_drafts set encrypted_payload=(select encrypted_payload from peragus_individual_onboarding_drafts where customer_id=$1) where customer_id=$2", [a.customer.id, b.customer.id]);
    let logs = ""; const output = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
    const app = await appFor(b, true, output);
    const corrupted = await app.inject({ method: "GET", url: path, headers });
    expect(corrupted.statusCode).toBe(503); expect(corrupted.json().error.code).toBe("INDIVIDUAL_DRAFT_UNAVAILABLE");
    const invalid = await app.inject({ method: "PUT", url: path, headers: { ...headers, "content-type": "application/json" }, payload: '"52998224725" PRIVATE' });
    expect(invalid.statusCode).toBe(400); expect(invalid.body).not.toContain("52998224725");
    expect(logs).not.toContain("52998224725"); expect(logs).not.toContain(key); expect(logs).not.toContain("PRIVATE");
    const wrong = new IndividualDraftService(drafts, new DraftCipher(randomBytes(32).toString("base64"), "test-v1"));
    await expect(wrong.read(a.customer.id)).rejects.toThrow();
    await expect(wrong.save(a.customer.id, 1, individualDraftSchema(clock).parse(fixture()))).rejects.toThrow();
  });
  it("revokes browser access and enforces test-only rows", async () => {
    const r = await db.query(`select relrowsecurity, has_table_privilege('anon','peragus_individual_onboarding_drafts','SELECT') as anon_select,
      has_table_privilege('authenticated','peragus_individual_onboarding_drafts','INSERT') as auth_insert
      from pg_class where relname='peragus_individual_onboarding_drafts'`);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, anon_select: false, auth_insert: false });
    const a = await profile();
    await expect(db.query("insert into peragus_individual_onboarding_drafts(customer_id,environment,encrypted_payload) values($1,'live','{}')", [a.customer.id])).rejects.toThrow();
  });
});
