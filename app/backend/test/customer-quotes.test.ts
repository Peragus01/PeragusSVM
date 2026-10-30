import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { PostgresOnboardingSubmissionRepository } from "../src/repositories/postgres-onboarding-submission.js";
import { PostgresCustomerQuoteRepository } from "../src/repositories/postgres-customer-quotes.js";
import {
  CustomerQuoteService,
  normalizeQuoteBrl,
} from "../src/quotes/customer-quotes.js";
import {
  OzavClient,
  type OzavWriteRequest,
} from "../src/providers/ozav-client.js";
const db = new PGlite();
let failSave = false;
const pool = {
  query: async (sql: string, params?: unknown[]) => {
    if (failSave && sql.includes("set provider_quote_id=")) {
      failSave = false;
      throw new Error("storage unavailable");
    }
    const r = await db.query(sql, params);
    return { ...r, rowCount: r.rows.length };
  },
} as unknown as Pool;
const customers = new PostgresCustomerRepository(pool),
  submissions = new PostgresOnboardingSubmissionRepository(pool),
  repo = new PostgresCustomerQuoteRepository(pool);
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
}, 30000);
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.close();
});
async function setup(type: "pf" | "pj" = "pf") {
  const owner = randomUUID(),
    customer = (
      await customers.createOrGet({
        ownerUserId: owner,
        type,
        displayName: "Synthetic",
      })
    ).customer;
  const providerId = `ozav_cus_${customer.id.replaceAll("-", "")}`,
    terms = randomUUID();
  await db.query(
    "insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until) values($1,$2,$3,now())",
    [terms, customer.id, randomUUID()],
  );
  await db.query(
    `insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode)
 values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full')`,
    [
      randomUUID(),
      customer.id,
      terms,
      "a".repeat(64),
      randomUUID(),
      providerId,
    ],
  );
  const caps = {
    environment: "test",
    entitlements: ["customers", "liquidity"],
    scopes: ["customers:read", "quotes:write"],
  };
  let status = "approved",
    pending = false,
    timeout = false,
    errorStatus = 0,
    mutate = (r: any) => r;
  const transport = vi.fn(async (path: string) => {
    if (path === "/v2/capabilities") return { statusCode: 200, body: caps };
    expect(path).toBe(`/v2/customers/${providerId}`);
    return {
      statusCode: 200,
      body: {
        id: providerId,
        object: "customer",
        type: "individual",
        external_ref: `peragus-onboarding-test:${customer.id}`,
        status,
        verification: { mode: "full", status },
        requirements: {
          due: [],
          due_codes: [],
          missing_fields: pending ? ["occupation"] : [],
          documents_due: [],
        },
      },
    };
  });
  const raw = (amount: string) => ({
    id: `ozav_q_${randomUUID().replaceAll("-", "")}`,
    object: "quote",
    customer_id: providerId,
    rate_type: "floating",
    rate: "0.2",
    source: { currency: "BRL", amount },
    target: { currency: "USDT", amount: "100.000000" },
    exchange_conditions: {
      spread_bps: 0,
      rate_without_spread: "0.2",
      private_margin: "never expose",
    },
    expires_at: null,
    created_at: new Date().toISOString(),
    private_data: "never persist",
  });
  const writeTransport = vi.fn(async (request: OzavWriteRequest) => {
    expect(request.path).toBe("/v2/quotes");
    expect(request.idempotencyKey).toBeUndefined();
    expect(request.body).toMatchObject({
      customer_id: providerId,
      target: { currency: "USDT", chain: "solana" },
      source_rail: "pix",
      spread_bps: 0,
    });
    const rows = await db.query(
      "select create_attempted from peragus_customer_indicative_quotes where customer_id=$1",
      [customer.id],
    );
    expect(rows.rows.some((r: any) => r.create_attempted)).toBe(true);
    if (timeout) throw new Error("unknown outcome");
    if (errorStatus)
      return {
        statusCode: errorStatus,
        body: { error: { message: "private server details" } },
      };
    return {
      statusCode: 201,
      body: mutate(raw((request.body.source as any).amount)),
    };
  });
  const provider = new OzavClient({
    apiKey: "ozav_sk_test_quote",
    attempts: 1,
    transport,
    writeTransport,
  });
  const service = new CustomerQuoteService(repo, submissions, provider);
  return {
    owner,
    customer,
    providerId,
    caps,
    service,
    provider,
    transport,
    writeTransport,
    requestId: randomUUID(),
    setStatus: (s: string) => {
      status = s;
    },
    setPending: () => {
      pending = true;
    },
    loseResponse: () => {
      timeout = true;
    },
    fail: (n: number) => {
      errorStatus = n;
    },
    mutate: (fn: (r: any) => any) => {
      mutate = fn;
    },
  };
}
const path = "/v1/me/quotes",
  headers = { authorization: "Bearer valid" };
async function appFor(s: Awaited<ReturnType<typeof setup>>, enabled = true) {
  const app = await buildApp({
    customerAccess: {
      customers,
      authenticate: async (token) => {
        if (token !== "valid") throw new AuthenticationError("INVALID_TOKEN");
        return { id: s.owner, email: "private@example.test" };
      },
    },
    ...(enabled ? { customerQuoteService: s.service } : {}),
  });
  apps.push(app);
  return app;
}
describe("owned indicative BRL to USDT quotes", () => {
  it("creates a floating non-executable quote with no transfer, wallet requirement or local approval", async () => {
    const s = await setup(),
      app = await appFor(s),
      r = await app.inject({
        method: "POST",
        url: path,
        headers,
        payload: { request_id: s.requestId, source_amount_brl: "500" },
      });
    expect(r.statusCode).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers.location).toBe(`${path}/${r.json().data.id}`);
    expect(r.json().data).toMatchObject({
      source: { amount: "500.00", currency: "BRL" },
      target: { currency: "USDT", chain: "solana" },
      rate_type: "floating",
      expires_at: null,
      executable: false,
      indicative: true,
      operations_enabled: false,
      external_delivery_costs_evaluated: false,
    });
    expect(r.body).not.toContain("never expose");
    expect(r.body).not.toContain("never persist");
    expect(r.body).not.toContain(s.providerId);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
    expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe(
      "draft",
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/settlements",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const empty = await db.query(
      "select (select count(*) from peragus_customer_wallets) as wallets,(select count(*) from settlements) as settlements",
    );
    expect(Number((empty.rows[0] as any).wallets)).toBe(0);
    expect(Number((empty.rows[0] as any).settlements)).toBe(0);
  });
  it("normalizes decimal strings exactly and refuses nonpositive, oversized, exponent, leading-zero, float and excess-precision inputs", () => {
    expect(normalizeQuoteBrl("0.01")).toBe("0.01");
    expect(normalizeQuoteBrl("1.2")).toBe("1.20");
    expect(normalizeQuoteBrl("10000")).toBe("10000.00");
    for (const value of [
      "0",
      "0.00",
      "-1",
      "01",
      "1e3",
      "1.234",
      "10000.01",
      "100000",
      " 1 ",
      "NaN",
    ])
      expect(() => normalizeQuoteBrl(value)).toThrow("QUOTE_AMOUNT_INVALID");
  });
  it("replays the same normalized intent without a provider call, conflicts on a changed amount and isolates identical request IDs by customer", async () => {
    const s = await setup(),
      first = await s.service.create(s.customer.id, s.requestId, "500"),
      again = await s.service.create(s.customer.id, s.requestId, "500.00");
    expect(again.replayed).toBe(true);
    expect(again.data.id).toBe(first.data.id);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
    await expect(
      s.service.create(s.customer.id, s.requestId, "501"),
    ).rejects.toThrow("QUOTE_IDEMPOTENCY_CONFLICT");
    const other = await setup(),
      second = await other.service.create(
        other.customer.id,
        s.requestId,
        "500",
      );
    expect(second.data.id).not.toBe(first.data.id);
  });
  it("reads only owned local IDs and cached history does not claim it refreshed the market", async () => {
    const s = await setup(),
      other = await setup(),
      first = await s.service.create(s.customer.id, s.requestId, "500");
    const calls = s.transport.mock.calls.length;
    expect(await s.service.read(s.customer.id, first.data.id)).toMatchObject({
      id: first.data.id,
      executable: false,
    });
    expect(s.transport).toHaveBeenCalledTimes(calls);
    await expect(
      other.service.read(other.customer.id, first.data.id),
    ).rejects.toThrow("QUOTE_NOT_FOUND");
    const r = await (
      await appFor(other)
    ).inject({ method: "GET", url: `${path}/${first.data.id}`, headers });
    expect(r.statusCode).toBe(404);
  });
  it("does not repeat a provider POST after timeout or local persistence failure and exposes the owned recovery ID", async () => {
    const s = await setup();
    s.loseResponse();
    const app = await appFor(s),
      first = await app.inject({
        method: "POST",
        url: path,
        headers,
        payload: { request_id: s.requestId, source_amount_brl: "500" },
      });
    expect(first.statusCode).toBe(502);
    expect(first.json().error.automatic_retry).toBe(false);
    expect(first.json().error.quote_id).toBeTruthy();
    const retry = await app.inject({
      method: "POST",
      url: path,
      headers,
      payload: { request_id: s.requestId, source_amount_brl: "500" },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe("QUOTE_RECOVERY_REQUIRED");
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
    const read = await s.service.read(
      s.customer.id,
      first.json().error.quote_id,
    );
    expect(read.state).toBe("uncertain");
    expect(read.target).toBeNull();
    const failed = await setup();
    failSave = true;
    await expect(
      failed.service.create(failed.customer.id, failed.requestId, "500"),
    ).rejects.toThrow("storage unavailable");
    await expect(
      failed.service.create(failed.customer.id, failed.requestId, "500"),
    ).rejects.toThrow("QUOTE_RECOVERY_REQUIRED");
    expect(failed.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("allows only one competing creation to claim the durable intent", async () => {
    const s = await setup();
    const results = await Promise.allSettled([
      s.service.create(s.customer.id, s.requestId, "500"),
      s.service.create(s.customer.id, s.requestId, "500.00"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("requires test liquidity capabilities, a linked owned customer and fresh approved full-mode requirements", async () => {
    const missing = await setup();
    missing.caps.scopes = ["customers:read"];
    await expect(
      missing.service.create(missing.customer.id, missing.requestId, "500"),
    ).rejects.toThrow("QUOTE_CAPABILITY_REQUIRED");
    expect(missing.writeTransport).not.toHaveBeenCalled();
    const rejected = await setup();
    rejected.setStatus("rejected");
    await expect(
      rejected.service.create(rejected.customer.id, rejected.requestId, "500"),
    ).rejects.toThrow("QUOTE_CUSTOMER_NOT_READY");
    const pending = await setup();
    pending.setPending();
    await expect(
      pending.service.create(pending.customer.id, pending.requestId, "500"),
    ).rejects.toThrow("QUOTE_CUSTOMER_NOT_READY");
    const absent = await setup();
    await db.query(
      "delete from peragus_customer_onboarding_submissions where customer_id=$1",
      [absent.customer.id],
    );
    await expect(
      absent.service.create(absent.customer.id, absent.requestId, "500"),
    ).rejects.toThrow("QUOTE_CUSTOMER_REQUIRED");
  });
  it("rejects foreign, wrong-currency/network/amount, locked, spread-bearing, nonpositive or composite responses", async () => {
    const changes = [
      (q: any) => ({ ...q, customer_id: "ozav_cus_foreign" }),
      (q: any) => ({ ...q, target: { ...q.target, currency: "USDC" } }),
      (q: any) => ({ ...q, target: { ...q.target, chain: "tron" } }),
      (q: any) => ({ ...q, source: { ...q.source, amount: "501.00" } }),
      (q: any) => ({ ...q, rate_type: "locked" }),
      (q: any) => ({ ...q, rate: "0" }),
      (q: any) => ({ ...q, expires_at: undefined }),
      (q: any) => ({ ...q, exchange_conditions: { spread_bps: 40 } }),
      (q: any) => ({ ...q, via: { currency: "USDT" } }),
      (q: any) => ({
        ...q,
        exchange_conditions: { spread_bps: 0, rate_without_spread: "0.3" },
      }),
    ];
    for (const change of changes) {
      const s = await setup();
      s.mutate(change);
      await expect(
        s.service.create(s.customer.id, s.requestId, "500"),
      ).rejects.toThrow("QUOTE_PROVIDER_UNAVAILABLE");
      expect(
        (await repo.findRequest(s.customer.id, s.requestId))?.quote,
      ).toBeNull();
    }
  });
  it("preserves published deduction/rate fields without pretending they cover subsequent self-custody delivery", async () => {
    const s = await setup();
    s.mutate((q) => ({
      ...q,
      exchange_conditions: {
        spread_bps: 0,
        rate_without_spread: "0.2",
        amount_deducted: "1.50",
      },
    }));
    const r = await s.service.create(s.customer.id, s.requestId, "500");
    expect(r.data.exchange_conditions).toEqual({
      spread_bps: 0,
      rate_without_spread: "0.2",
      amount_deducted: "1.50",
    });
    expect(r.data.external_delivery_costs_evaluated).toBe(false);
    const bad = await setup();
    bad.mutate((q) => ({
      ...q,
      exchange_conditions: { spread_bps: 0, amount_deducted: "500.00" },
    }));
    await expect(
      bad.service.create(bad.customer.id, bad.requestId, "500"),
    ).rejects.toThrow();
  });
  it("enforces authentication, feature/PF gates, strict inputs and no reflected JSON or provider details", async () => {
    const s = await setup(),
      pj = await setup("pj"),
      app = await appFor(s),
      payload = { request_id: s.requestId, source_amount_brl: "500" };
    expect(
      (await app.inject({ method: "POST", url: path, payload })).statusCode,
    ).toBe(401);
    expect(
      (
        await (
          await appFor(s, false)
        ).inject({ method: "POST", url: path, headers, payload })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await (
          await appFor(pj)
        ).inject({ method: "POST", url: path, headers, payload })
      ).statusCode,
    ).toBe(403);
    for (const extra of [
      { customer_id: s.providerId },
      { spread_bps: 40 },
      { target_currency: "USDC" },
      { wallet_address: "arbitrary" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers,
            payload: { ...payload, ...extra },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { ...payload, source_amount_brl: 500 },
        })
      ).statusCode,
    ).toBe(400);
    const malformed = await app.inject({
      method: "POST",
      url: path,
      headers: { ...headers, "content-type": "application/json" },
      payload: '{"private":"secret",',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain("secret");
    s.fail(422);
    const failure = await app.inject({
      method: "POST",
      url: path,
      headers,
      payload,
    });
    expect(failure.statusCode).toBe(502);
    expect(failure.json().error.provider_http_status).toBe(422);
    expect(failure.body).not.toContain("private server");
    await db.query("update peragus_customers set suspended=true where id=$1", [
      s.customer.id,
    ]);
    expect(
      (await app.inject({ method: "POST", url: path, headers, payload }))
        .statusCode,
    ).toBe(403);
  });
  it("enforces test-only storage, database precision/limits and browser isolation", async () => {
    const s = await setup(),
      r = await s.service.create(s.customer.id, s.requestId, "500");
    await expect(
      db.query(
        "update peragus_customer_indicative_quotes set environment='live' where id=$1",
        [r.data.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "update peragus_customer_indicative_quotes set source_amount_brl=10000.01 where id=$1",
        [r.data.id],
      ),
    ).rejects.toThrow();
    const row = await db.query(
      "select relrowsecurity,has_table_privilege('anon','peragus_customer_indicative_quotes','SELECT') as anon_select,has_table_privilege('authenticated','peragus_customer_indicative_quotes','INSERT') as auth_insert from pg_class where relname='peragus_customer_indicative_quotes'",
    );
    expect(row.rows[0]).toEqual({
      relrowsecurity: true,
      anon_select: false,
      auth_insert: false,
    });
  });
});

describe("target-side indicative quotes", () => {
  it("sends target.amount to OZAV and saves the returned BRL without client-side inversion", async () => {
    const s = await setup();
    s.mutate((row) => ({
      ...row,
      source: { currency: "BRL", amount: "1000.00" },
      target: { currency: "USDT", amount: "200.000000" },
    }));
    const result = await s.service.create(
      s.customer.id,
      s.requestId,
      "200",
      true,
    );
    expect(result.data.source.amount).toBe("1000.00");
    expect(result.data.target?.amount).toBe("200.000000");
    expect(s.writeTransport.mock.calls[0]![0].body.source).toEqual({
      currency: "BRL",
    });
    expect(s.writeTransport.mock.calls[0]![0].body.target).toEqual({
      currency: "USDT",
      chain: "solana",
      amount: "200.000000",
    });
    expect(
      (await s.service.create(s.customer.id, s.requestId, "200.000000", true))
        .replayed,
    ).toBe(true);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
    await expect(
      s.service.create(s.customer.id, s.requestId, "201", true),
    ).rejects.toThrow("QUOTE_IDEMPOTENCY_CONFLICT");
    await expect(
      s.service.create(s.customer.id, s.requestId, "1000.00"),
    ).rejects.toThrow("QUOTE_IDEMPOTENCY_CONFLICT");
  });
  it("preserves an uncertain target quote and never repeats its provider POST", async () => {
    const s = await setup();
    s.loseResponse();
    await expect(
      s.service.create(s.customer.id, s.requestId, "200", true),
    ).rejects.toThrow();
    await expect(
      s.service.create(s.customer.id, s.requestId, "200", true),
    ).rejects.toThrow("QUOTE_RECOVERY_REQUIRED");
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("refuses a target amount mismatch or out-of-range source returned by the provider", async () => {
    for (const changes of [
      {
        source: { currency: "BRL", amount: "10001.00" },
        target: { currency: "USDT", amount: "200.000000" },
      },
      {
        source: { currency: "BRL", amount: "1000.00" },
        target: { currency: "USDT", amount: "199.000000" },
      },
    ]) {
      const s = await setup();
      s.mutate((row) => ({ ...row, ...changes }));
      await expect(
        s.service.create(s.customer.id, s.requestId, "200", true),
      ).rejects.toThrow();
      expect(s.writeTransport).toHaveBeenCalledTimes(1);
    }
  });
});
