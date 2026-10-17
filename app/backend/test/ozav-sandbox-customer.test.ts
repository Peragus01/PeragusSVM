import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { OzavSandboxCustomerService, sandboxCustomerFixture } from "../src/application/ozav-sandbox-customer.js";
import { PostgresSandboxCustomerLinkRepository } from "../src/repositories/postgres-sandbox-customer-link.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { OzavClient, type OzavWriteRequest } from "../src/providers/ozav-client.js";

const db = new PGlite();
const pool = { query: async (sql: string, params?: unknown[]) => {
  const r = await db.query(sql, params); return { ...r, rowCount: r.rows.length };
} } as unknown as Pool;
const links = new PostgresSandboxCustomerLinkRepository(pool), customers = new PostgresCustomerRepository(pool);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const apiKey = "ozav_sk_test_fixture";
const caps = { environment: "test", scopes: ["customers:read", "customers:write"], entitlements: ["customers", "custody", "self_custody", "kyc_reliance"] };
function clientWith(write: (input: OzavWriteRequest) => Promise<any>, capability = caps) {
  const transport = vi.fn(async () => ({ statusCode: 200, body: capability }));
  const writeTransport = vi.fn(write);
  const client = new OzavClient({ apiKey, transport, writeTransport, attempts: 1 });
  return { client, transport, writeTransport };
}
function reply(input: OzavWriteRequest, id = "ozav_cus_testfixture") {
  return { statusCode: 201, body: { id, object: "customer", type: "individual",
    external_ref: input.body.external_ref, email: input.body.email, status: "pending", verification: { mode: "full" } } };
}
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon, authenticated;");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(f, dir), "utf8"));
}, 30000);
afterAll(async () => { await Promise.all(apps.map(app => app.close())); await db.close(); });
async function profile(type: "pf" | "pj" = "pf") {
  const userId = randomUUID();
  const p = (await customers.createOrGet({ ownerUserId: userId, type, displayName: "Local test" })).customer;
  return { ...p, userId };
}
async function appFor(actor: Awaited<ReturnType<typeof profile>>, service?: OzavSandboxCustomerService) {
  const app = await buildApp({ customerAccess: { customers, authenticate: async token => {
    if (token !== "valid") throw new AuthenticationError("INVALID_TOKEN");
    return { id: actor.userId, email: "actual-user@example.test" };
  } }, ...(service ? { ozavSandboxCustomerService: service } : {}) });
  apps.push(app); return app;
}
const path = "/v1/me/ozav-sandbox-customer", headers = { authorization: "Bearer valid" };
describe("sandbox customer fixtures and durable binding", () => {
  it("generates stable distinct synthetic identities with valid CPF checksums", () => {
    const a = randomUUID(), b = randomUUID();
    const one = sandboxCustomerFixture(a), two = sandboxCustomerFixture(b);
    expect(one).toEqual(sandboxCustomerFixture(a)); expect(one.taxId).not.toBe(two.taxId);
    expect(one.email).toBe(`peragus-sandbox-${a}@example.com`);
    const n = one.taxId.split("").map(Number);
    for (const count of [9, 10]) {
      const sum = n.slice(0, count).reduce((total, digit, i) => total + digit * (count + 1 - i), 0);
      expect(n[count]).toBe(((sum * 10) % 11) % 10);
    }
  });
  it("enforces test keys, strict generated input and test capabilities", async () => {
    expect(() => new OzavClient({ apiKey: "ozav_sk_live_private" })).toThrow();
    const { client } = clientWith(async input => reply(input));
    await expect(client.createSandboxCustomer({ ...sandboxCustomerFixture(randomUUID()), email: "real@example.test" }, "bad")).rejects.toThrow();
    const actor = await profile();
    const wrong = clientWith(async input => reply(input), { ...caps, environment: "live" });
    await expect(new OzavSandboxCustomerService(links, wrong.client).execute(actor.id)).rejects.toThrow();
    expect(wrong.writeTransport).not.toHaveBeenCalled();
  });
  it("creates and replays one linked fixture without approving the local profile", async () => {
    const actor = await profile();
    const mocks = clientWith(async input => reply(input, `ozav_cus_${actor.id.replaceAll("-", "")}`));
    const app = await appFor(actor, new OzavSandboxCustomerService(links, mocks.client));
    const initial = await app.inject({ method: "GET", url: path, headers }); expect(initial.json().data).toBeNull();
    const first = await app.inject({ method: "POST", url: path, headers, payload: {} });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ customer_id: actor.id, environment: "test", sandbox_fixture: true, state: "linked", verification_mode: "full", operations_enabled: false });
    const replay = await app.inject({ method: "POST", url: path, headers });
    expect(replay.statusCode).toBe(200); expect(replay.json().data.ozav_customer_id).toBe(first.json().data.ozav_customer_id);
    expect(mocks.writeTransport).toHaveBeenCalledTimes(1);
    const sent = mocks.writeTransport.mock.calls[0]![0];
    expect(sent.path).toBe("/v2/customers");
    expect(sent.idempotencyKey).toBe(`peragus-customer-test-${actor.id}`);
    expect(sent.body).toMatchObject({ verification_mode: "full", custody_model: "managed", monitoring: false });
    expect(JSON.stringify(sent.body)).not.toContain("actual-user@example.test");
    const me = await app.inject({ method: "GET", url: "/v1/me", headers });
    expect(me.json().data.customer.verification_status).toBe("draft");
    expect(me.json().data.customer.operations_enabled).toBe(false);
    expect((await app.inject({ method: "POST", url: "/v1/settlements", headers, payload: {} })).statusCode).toBe(403);
  });
  it("isolates binding reads and refuses PJ, spoofed input, unauthenticated and disabled requests", async () => {
    const actor = await profile(), other = await profile(), pj = await profile("pj");
    const mocks = clientWith(async input => reply(input, `ozav_cus_${actor.id.replaceAll("-", "")}`));
    const service = new OzavSandboxCustomerService(links, mocks.client);
    await service.execute(actor.id);
    const app = await appFor(other, service);
    expect((await app.inject({ method: "GET", url: `${path}?customer_id=${actor.id}`, headers })).json().data).toBeNull();
    expect((await app.inject({ method: "POST", url: path, headers, payload: { customer_id: actor.id } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: path, payload: {} })).statusCode).toBe(401);
    const disabled = await appFor(other);
    expect((await disabled.inject({ method: "POST", url: path, headers, payload: {} })).statusCode).toBe(503);
    const pjApp = await appFor(pj, service);
    expect((await pjApp.inject({ method: "POST", url: path, headers, payload: {} })).statusCode).toBe(403);
    expect(mocks.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("retains an intent after an unknown timeout and retries with exactly the same payload/key", async () => {
    const actor = await profile(); let count = 0;
    const mocks = clientWith(async input => { if (count++ === 0) throw new Error("transport timeout secret"); return reply(input, `ozav_cus_${actor.id.replaceAll("-", "")}`); });
    const service = new OzavSandboxCustomerService(links, mocks.client);
    await expect(service.execute(actor.id)).rejects.toThrow("OZAV connection failed");
    expect((await service.read(actor.id))?.state).toBe("pending");
    const result = await service.execute(actor.id); expect(result.link.state).toBe("linked");
    expect(mocks.writeTransport.mock.calls[0]![0]).toEqual(mocks.writeTransport.mock.calls[1]![0]);
  });
  it("recovers the same provider result after a local persistence failure", async () => {
    const actor = await profile(); let fail = true;
    const mocks = clientWith(async input => reply(input, `ozav_cus_${actor.id.replaceAll("-", "")}`));
    const unstable = { find: links.find.bind(links), reserve: links.reserve.bind(links), complete: async (...args: Parameters<typeof links.complete>) => {
      if (fail) { fail = false; throw new Error("DB unavailable"); }
      return links.complete(...args);
    } };
    const service = new OzavSandboxCustomerService(unstable, mocks.client);
    await expect(service.execute(actor.id)).rejects.toThrow("DB unavailable");
    expect((await service.execute(actor.id)).link.state).toBe("linked");
    expect(mocks.writeTransport.mock.calls[0]![0]).toEqual(mocks.writeTransport.mock.calls[1]![0]);
  });
  it.each(["reliance", "wrong_ref", "wrong_email"])("refuses mismatched provider response %s", async field => {
    const actor = await profile();
    const mocks = clientWith(async input => {
      const response = reply(input);
      if (field === "reliance") response.body.verification.mode = "reliance";
      if (field === "wrong_ref") response.body.external_ref = "someone_else";
      if (field === "wrong_email") response.body.email = "someone@example.test";
      return response;
    });
    await expect(new OzavSandboxCustomerService(links, mocks.client).execute(actor.id)).rejects.toThrow();
    expect((await links.find(actor.id))?.ozavCustomerId).toBeNull();
  });
  it("keeps unknown verification posture unknown even if the provider says approved", async () => {
    const actor = await profile();
    const mocks = clientWith(async input => ({ ...reply(input, `ozav_cus_${actor.id.replaceAll("-", "")}`), body: {
      ...reply(input, `ozav_cus_${actor.id.replaceAll("-", "")}`).body, verification: {}, status: "approved",
    } }));
    const result = await new OzavSandboxCustomerService(links, mocks.client).execute(actor.id);
    expect(result.link.verificationMode).toBeNull();
    expect((await customers.findByOwner(actor.userId))?.verificationStatus).toBe("draft");
  });
  it("does not automatically bind a provider duplicate or expose its error body", async () => {
    const actor = await profile();
    const mocks = clientWith(async () => ({ statusCode: 409, body: { error: { code: "CUSTOMER_ALREADY_EXISTS", details: { existing_id: "secret-other-customer" } } } }));
    const app = await appFor(actor, new OzavSandboxCustomerService(links, mocks.client));
    const r = await app.inject({ method: "POST", url: path, headers, payload: {} });
    expect(r.statusCode).toBe(502); expect(r.json().error.provider_http_status).toBe(409);
    expect(r.body).not.toContain("secret-other-customer"); expect((await links.find(actor.id))?.state).toBe("pending");
  });
  it("requires custody/customer entitlements and rejects a shared provider ID across local customers", async () => {
    const actor = await profile();
    const mocks = clientWith(async input => reply(input), { ...caps, entitlements: ["customers"] });
    await expect(new OzavSandboxCustomerService(links, mocks.client).execute(actor.id)).rejects.toThrow("SANDBOX_CUSTOMER_CAPABILITY_MISSING");
    expect(mocks.writeTransport).not.toHaveBeenCalled();
    const a = await profile(), b = await profile(); const id = `ozav_cus_unique${a.id.replaceAll("-", "")}`;
    const client = clientWith(async input => reply(input, id)).client;
    await new OzavSandboxCustomerService(links, client).execute(a.id);
    await expect(new OzavSandboxCustomerService(links, client).execute(b.id)).rejects.toThrow("SANDBOX_CUSTOMER_CONFLICT");
  });
  it("enforces test-only environment and browser-role table restrictions", async () => {
    const actor = await profile();
    await expect(db.query("insert into peragus_ozav_sandbox_customer_links(customer_id,environment,idempotency_key,request_hash) values($1,'live',$2,$3)", [actor.id, randomUUID(), "a".repeat(64)])).rejects.toThrow();
    const r = await db.query(`select relrowsecurity, has_table_privilege('anon','peragus_ozav_sandbox_customer_links','SELECT') as anon_select,
      has_table_privilege('authenticated','peragus_ozav_sandbox_customer_links','INSERT') as auth_insert
      from pg_class where relname='peragus_ozav_sandbox_customer_links'`);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, anon_select: false, auth_insert: false });
  });
});
