import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { PostgresLegalAcceptanceRepository } from "../src/repositories/postgres-customer-legal-acceptances.js";
import {
  LegalAcceptanceService,
  parseLegalRequiredDocuments,
  sanitizeUserAgent,
} from "../src/legal/legal-acceptance.js";

const db = new PGlite();
let connection = Promise.resolve();
const query = async (sql: string, params?: unknown[]) => {
  const r = await db.query(sql, params);
  return { ...r, rowCount: r.rows.length };
};
const pool = {
  query,
  connect: async () => {
    const previous = connection;
    let release!: () => void;
    connection = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return { query, release };
  },
} as unknown as Pool;
const customers = new PostgresCustomerRepository(pool);
const repo = new PostgresLegalAcceptanceRepository(pool, "test");
const h = (c: string) => c.repeat(64);
const docs = (version = "draft-0.9-2026-11-03", hash = "a") =>
  JSON.stringify({
    terms: { version, sha256: h(hash) },
    privacy: { version, sha256: h("b") },
    refund: { version, sha256: h("c") },
  });
const serviceFor = (version?: string, hash?: string) =>
  new LegalAcceptanceService(
    parseLegalRequiredDocuments(docs(version, hash)),
    repo,
  );
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
beforeAll(async () => {
  await db.exec(
    "create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;",
  );
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of (await readdir(dir))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort())
    await db.exec(await readFile(new URL(f, dir), "utf8"));
  await db.exec(
    "insert into peragus_database_environment(environment) values('test')",
  );
}, 30000);
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});
async function appFor(
  legal: LegalAcceptanceService | undefined,
  operators = new Set<string>(),
) {
  const app = await buildApp({
    customerAccess: {
      customers,
      ...(legal ? { legal } : {}),
      authenticate: async (token: string) => {
        if (!token.startsWith("u-")) throw new AuthenticationError("INVALID_TOKEN");
        return { id: token.slice(2), email: "x@example.test" };
      },
    },
    operatorUserIds: operators,
  });
  apps.push(app);
  return app;
}
async function newCustomer() {
  const owner = randomUUID();
  const customer = (
    await customers.createOrGet({
      ownerUserId: owner,
      type: "pf",
      displayName: "Synthetic name",
    })
  ).customer;
  return { owner, customer, headers: { authorization: `Bearer u-${owner}` } };
}
const accept = (version = "draft-0.9-2026-11-03", which = ["terms", "privacy", "refund"]) => ({
  documents: which.map((document) => ({ document, version })),
});
const GATED: [string, string][] = [
  ["POST", "/v1/me/quotes"],
  ["GET", "/v1/me/quotes/" + randomUUID()],
  ["GET", "/v1/me/onboarding/status"],
  ["POST", "/v1/me/onboarding/individual"],
  ["POST", "/v1/me/purchase-intents"],
  ["GET", "/v1/me/operations"],
  ["POST", "/v1/me/withdrawal-requests"],
  ["POST", "/v1/settlements"],
];

describe("LEGAL_REQUIRED_DOCUMENTS shape", () => {
  it("accepts the strict shape and records versions exactly as configured", () => {
    expect(parseLegalRequiredDocuments(docs())).toEqual([
      { document: "terms", version: "draft-0.9-2026-11-03", sha256: h("a") },
      { document: "privacy", version: "draft-0.9-2026-11-03", sha256: h("b") },
      { document: "refund", version: "draft-0.9-2026-11-03", sha256: h("c") },
    ]);
  });
  it.each([
    "not json",
    "{}",
    JSON.stringify({ terms: { version: "v", sha256: h("a") } }),
    docs().replace(h("a"), "A".repeat(64)),
    docs().replace(h("a"), "a".repeat(63)),
    JSON.stringify({ ...JSON.parse(docs()), extra: { version: "v", sha256: h("a") } }),
    JSON.stringify({ ...JSON.parse(docs()), terms: { version: "", sha256: h("a") } }),
  ])("rejects %s", (raw) => {
    expect(() => parseLegalRequiredDocuments(raw)).toThrow("LEGAL_REQUIRED_DOCUMENTS_INVALID");
  });
  it("truncates and cleans the user agent", () => {
    expect(sanitizeUserAgent("a".repeat(2000))).toHaveLength(512);
    expect(sanitizeUserAgent("Mo\nzilla\u0000")).toBe("Mozilla");
    expect(sanitizeUserAgent(undefined)).toBeNull();
  });
});

describe("legal acceptance gate", () => {
  it("customer without acceptance gets LEGAL_ACCEPTANCE_REQUIRED on quotes, onboarding and purchase routes", async () => {
    const app = await appFor(serviceFor());
    const c = await newCustomer();
    for (const [method, url] of GATED) {
      const r = await app.inject({ method: method as "GET", url, headers: c.headers, payload: method === "POST" ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    }
  });
  it("keeps the exempt routes reachable and lists what is missing", async () => {
    const app = await appFor(serviceFor());
    const c = await newCustomer();
    for (const url of ["/v1/me", "/v1/me/customer", "/v1/me/purchase-capabilities", "/v1/me/legal-acceptances"])
      expect((await app.inject({ method: "GET", url, headers: c.headers })).statusCode, url).toBe(200);
    const r = await app.inject({ method: "GET", url: "/v1/me/legal-acceptances", headers: c.headers });
    expect(r.json().data.required).toHaveLength(3);
    expect(r.json().data.missing).toHaveLength(3);
    expect(r.json().data.missing[0]).toEqual({ document: "terms", version: "draft-0.9-2026-11-03", sha256: h("a") });
  });
  it("acceptance of current versions unlocks routes", async () => {
    const app = await appFor(serviceFor());
    const c = await newCustomer();
    const r = await app.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: { ...c.headers, "user-agent": "Mozilla/5.0 test" }, payload: accept() });
    expect(r.statusCode).toBe(201);
    expect(r.json().data.missing).toEqual([]);
    for (const [method, url] of GATED) {
      const g = await app.inject({ method: method as "GET", url, headers: c.headers, payload: method === "POST" ? {} : undefined });
      expect(g.json()?.error?.code, `${method} ${url}`).not.toBe("LEGAL_ACCEPTANCE_REQUIRED");
    }
    const row = (await db.query("select * from peragus_customer_legal_acceptances where customer_id=$1 order by document", [c.customer.id])).rows as any[];
    expect(row.map((x) => [x.document, x.version, x.sha256, x.user_id, x.environment, x.user_agent])).toEqual([
      ["privacy", "draft-0.9-2026-11-03", h("b"), c.owner, "test", "Mozilla/5.0 test"],
      ["refund", "draft-0.9-2026-11-03", h("c"), c.owner, "test", "Mozilla/5.0 test"],
      ["terms", "draft-0.9-2026-11-03", h("a"), c.owner, "test", "Mozilla/5.0 test"],
    ]);
    expect(row[0].ip).toBe("127.0.0.1");
  });
  it("replaying the same acceptance is idempotent", async () => {
    const app = await appFor(serviceFor());
    const c = await newCustomer();
    const send = () => app.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload: accept() });
    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(201);
    expect((await db.query("select count(*) as n from peragus_customer_legal_acceptances where customer_id=$1", [c.customer.id])).rows[0]).toEqual({ n: 3 });
  });
  it("partial acceptance leaves the rest missing and routes locked", async () => {
    const app = await appFor(serviceFor());
    const c = await newCustomer();
    const r = await app.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload: accept(undefined, ["terms"]) });
    expect(r.json().data.missing.map((m: any) => m.document)).toEqual(["privacy", "refund"]);
    expect((await app.inject({ method: "GET", url: "/v1/me/operations", headers: c.headers })).json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });
  it("changing a required version locks routes again", async () => {
    const c = await newCustomer();
    const v1 = await appFor(serviceFor());
    await v1.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload: accept() });
    expect((await v1.inject({ method: "GET", url: "/v1/me/operations", headers: c.headers })).json()?.error?.code).not.toBe("LEGAL_ACCEPTANCE_REQUIRED");
    const v2 = await appFor(serviceFor("draft-1.0-2026-12-01"));
    for (const [method, url] of GATED) {
      const r = await v2.inject({ method: method as "GET", url, headers: c.headers, payload: method === "POST" ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    }
    const status = await v2.inject({ method: "GET", url: "/v1/me/legal-acceptances", headers: c.headers });
    expect(status.json().data.missing).toHaveLength(3);
    expect((await v2.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload: accept("draft-1.0-2026-12-01") })).json().data.missing).toEqual([]);
    expect((await v2.inject({ method: "GET", url: "/v1/me/operations", headers: c.headers })).json()?.error?.code).not.toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });
  it("changing only the document hash under the same version locks routes", async () => {
    const c = await newCustomer();
    const v1 = await appFor(serviceFor());
    await v1.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload: accept() });
    const edited = await appFor(serviceFor(undefined, "d"));
    const r = await edited.inject({ method: "GET", url: "/v1/me/operations", headers: c.headers });
    expect(r.json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });
  it("acceptance of an old version is refused and records nothing", async () => {
    const app = await appFor(serviceFor("draft-1.0-2026-12-01"));
    const c = await newCustomer();
    const r = await app.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload: accept("draft-0.9-2026-11-03") });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("LEGAL_VERSION_MISMATCH");
    const mixed = await app.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload: { documents: [{ document: "terms", version: "draft-1.0-2026-12-01" }, { document: "privacy", version: "old" }] } });
    expect(mixed.json().error.code).toBe("LEGAL_VERSION_MISMATCH");
    expect((await db.query("select count(*) as n from peragus_customer_legal_acceptances where customer_id=$1", [c.customer.id])).rows[0]).toEqual({ n: 0 });
  });
  it("ignores client-supplied hash, customer and unknown fields", async () => {
    const app = await appFor(serviceFor());
    const c = await newCustomer();
    for (const payload of [
      { documents: [{ document: "terms", version: "draft-0.9-2026-11-03", sha256: h("f") }] },
      { documents: [{ document: "cookies", version: "draft-0.9-2026-11-03" }] },
      { documents: [] },
      { documents: [{ document: "terms", version: "draft-0.9-2026-11-03" }], customer_id: randomUUID() },
      {},
    ])
      expect((await app.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload })).statusCode).toBe(400);
  });
  it("does not trust a client-supplied forwarded address", async () => {
    const app = await appFor(serviceFor());
    const c = await newCustomer();
    await app.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: { ...c.headers, "x-forwarded-for": "203.0.113.9" }, payload: accept() });
    const ip = (await db.query("select ip from peragus_customer_legal_acceptances where customer_id=$1 limit 1", [c.customer.id])).rows[0] as any;
    expect(ip.ip).toBe("127.0.0.1");
  });
  it("does not affect operators without a customer profile", async () => {
    const op = randomUUID();
    const app = await appFor(serviceFor(), new Set([op]));
    const r = await app.inject({ method: "GET", url: "/v1/admin/operator-status", headers: { authorization: `Bearer u-${op}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.operator).toBe(true);
    const noProfile = await app.inject({ method: "GET", url: "/v1/me/legal-acceptances", headers: { authorization: `Bearer u-${op}` } });
    expect(noProfile.json().error.code).toBe("CUSTOMER_REQUIRED");
  });
  it("is not applied when no legal service is configured (existing deployments of the app factory)", async () => {
    const app = await appFor(undefined);
    const c = await newCustomer();
    expect((await app.inject({ method: "GET", url: "/v1/me/operations", headers: c.headers })).json()?.error?.code).not.toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });
});

describe("legal acceptance storage", () => {
  it("acceptance rows cannot be updated or deleted", async () => {
    const app = await appFor(serviceFor());
    const c = await newCustomer();
    await app.inject({ method: "POST", url: "/v1/me/legal-acceptances", headers: c.headers, payload: accept() });
    await expect(db.query("update peragus_customer_legal_acceptances set version='x' where customer_id=$1", [c.customer.id])).rejects.toThrow("LEGAL_ACCEPTANCES_APPEND_ONLY");
    await expect(db.query("delete from peragus_customer_legal_acceptances where customer_id=$1", [c.customer.id])).rejects.toThrow("LEGAL_ACCEPTANCES_APPEND_ONLY");
  });
  it("enforces document, hash shape and row environment", async () => {
    const c = await newCustomer();
    const ins = (doc: string, sha: string, env: string) =>
      db.query("insert into peragus_customer_legal_acceptances(user_id,customer_id,document,version,sha256,environment) values($1,$2,$3,'v',$4,$5)", [c.owner, c.customer.id, doc, sha, env]);
    await expect(ins("cookies", h("a"), "test")).rejects.toThrow();
    await expect(ins("terms", "ABC", "test")).rejects.toThrow();
    await expect(ins("terms", h("a"), "live")).rejects.toThrow("ENVIRONMENT_MISMATCH");
    await ins("terms", h("a"), "test");
  });
  it("revokes direct access from client roles and enables RLS", async () => {
    const t = (await db.query("select relrowsecurity from pg_class where relname='peragus_customer_legal_acceptances'")).rows[0] as any;
    expect(t.relrowsecurity).toBe(true);
    const g = await db.query("select grantee from information_schema.role_table_grants where table_name='peragus_customer_legal_acceptances' and grantee in ('anon','authenticated','PUBLIC')");
    expect(g.rows).toEqual([]);
  });
});

describe("LEGAL_REQUIRED_DOCUMENTS env", () => {
  it("is validated by the env schema when present", async () => {
    const { getEnv } = await import("../src/config/env.js");
    const saved = process.env.LEGAL_REQUIRED_DOCUMENTS;
    try {
      process.env.LEGAL_REQUIRED_DOCUMENTS = '{"terms":{}}';
      expect(() => getEnv()).toThrow();
    } finally {
      if (saved === undefined) delete process.env.LEGAL_REQUIRED_DOCUMENTS;
      else process.env.LEGAL_REQUIRED_DOCUMENTS = saved;
    }
  });
});
