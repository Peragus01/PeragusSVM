import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PoolClient, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  onboardingReview,
  notificationMessage,
} from "../src/notifications/onboarding-result.js";
import {
  OnboardingEmailProcessor,
  emailNotificationReady,
} from "../src/notifications/onboarding-email.js";
import { ResendSender } from "../src/notifications/resend.js";
import { notificationConfig } from "../src/notifications/config.js";
import type { OverviewFacts } from "../src/onboarding/customer-onboarding-overview.js";
import type { Customer } from "../src/auth/customer-access.js";
const facts = (): OverviewFacts => ({
  binding_consistent: true,
  wallet: null,
  draft: null,
  terms: {
    session_id: randomUUID(),
    state: "accepted",
    version: "1",
    expires_at: null,
    accepted_at: new Date().toISOString(),
    active: true,
  },
  registration: {
    state: "linked",
    draft_version: 1,
    provider_status: "approved",
    verification_mode: "full",
    requirements_pending: false,
    due_count: 0,
    missing_fields_count: 0,
    documents_due_count: 0,
    refreshed_at: new Date().toISOString(),
  },
  identity: {
    status: "completed",
    checks: { kyc_document: "pass", liveness: "pass", face_match: "pass" },
    refreshed_at: new Date().toISOString(),
  },
  screening: {
    status: "completed",
    result: "clear",
    lists: [],
    matches_count: 0,
    suggested_decision: "clear",
    refreshed_at: new Date().toISOString(),
  },
});
const db = new PGlite();
const connection = {
  query: async (sql: string, params?: unknown[]) => {
    const r = await db.query(sql, params);
    return { ...r, rowCount: r.rows.length };
  },
} as unknown as PoolClient;
beforeAll(async () => {
  await db.exec(
    "create table peragus_customers(id uuid primary key); create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);",
  );
  await db.exec(
    await readFile(
      new URL(
        "../migrations/037_add_onboarding_email_outbox.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}, 30000);
afterAll(() => db.close());
async function setup() {
  const customer: Customer = {
    id: randomUUID(),
    ownerUserId: randomUUID(),
    type: "pf",
    displayName: "Synthetic",
    verificationStatus: "draft",
    suspended: false,
  };
  await db.query("insert into peragus_customers values($1)", [customer.id]);
  return customer;
}
describe("onboarding result notifications", () => {
  it("requires complete identity, independent compliance, accepted terms and matching binding; ignores wallet as a KYC result", () => {
    const f = facts();
    expect(onboardingReview(f)).toBe("approved");
    f.identity!.status = "pending";
    expect(onboardingReview(f)).toBe("pending_identity");
    f.identity!.status = "completed";
    f.screening!.result = "review";
    expect(onboardingReview(f)).toBe("in_review");
    f.identity!.checks.face_match = "fail";
    expect(onboardingReview(f)).toBe("rejected");
    f.binding_consistent = false;
    expect(onboardingReview(f)).toBe("not_submitted");
  });
  it("keeps incomplete and action-required evidence distinct from waiting", () => {
    const f = facts();
    f.registration!.requirements_pending = true;
    expect(onboardingReview(f)).toBe("action_required");
    f.terms = null;
    expect(onboardingReview(f)).toBe("not_submitted");
  });
  it("persists a single notification across duplicate observations and restarts", async () => {
    const c = await setup(),
      send = vi.fn().mockResolvedValue("synthetic-resend-id");
    const p = () =>
      new OnboardingEmailProcessor(
        connection,
        { send },
        "test@peragus.example",
        "https://staging.example/app/minha-conta",
        async () => facts(),
      );
    await p().process(c, "synthetic@example.test");
    await p().process(c, "synthetic@example.test");
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await db.query(
      "select state,resend_id from peragus_onboarding_email_outbox where customer_id=$1",
      [c.id],
    );
    expect(rows.rows).toEqual([
      { state: "accepted", resend_id: "synthetic-resend-id" },
    ]);
  });
  it("retries an uncertain send with identical ID and content; blocks after idempotency window", async () => {
    const c = await setup(),
      send = vi.fn().mockRejectedValue(new Error("uncertain"));
    const p = new OnboardingEmailProcessor(
      connection,
      { send },
      "test@peragus.example",
      "https://staging.example/app/minha-conta",
      async () => facts(),
    );
    await expect(p.process(c, "synthetic@example.test")).rejects.toThrow();
    await db.query(
      "update peragus_onboarding_email_outbox set next_attempt_at=now() where customer_id=$1",
      [c.id],
    );
    await expect(p.process(c, "synthetic@example.test")).rejects.toThrow();
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    await db.query(
      "update peragus_onboarding_email_outbox set first_attempt_at=now()-interval '24 hours',next_attempt_at=now() where customer_id=$1",
      [c.id],
    );
    await p.process(c, "synthetic@example.test");
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      (
        await db.query(
          "select state from peragus_onboarding_email_outbox where customer_id=$1",
          [c.id],
        )
      ).rows[0],
    ).toMatchObject({ state: "blocked" });
  });
  it("never retries to a changed recipient and suppresses stale outcomes", async () => {
    const c = await setup(),
      send = vi.fn().mockRejectedValue(new Error("uncertain"));
    let f = facts();
    const p = new OnboardingEmailProcessor(
      connection,
      { send },
      "test@peragus.example",
      "https://staging.example/app/minha-conta",
      async () => f,
    );
    await expect(p.process(c, "first@example.test")).rejects.toThrow();
    await p.process(c, "second@example.test");
    expect(send).toHaveBeenCalledTimes(1);
    f = facts();
    f.identity!.status = "pending";
    await p.process(c, "second@example.test");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not send if provider refresh fails or identity has not been captured", async () => {
    const c = await setup(),
      send = vi.fn();
    const f = facts();
    f.identity = null;
    await new OnboardingEmailProcessor(
      connection,
      { send },
      "a@example.test",
      "https://example.test",
      async () => f,
    ).process(c, "b@example.test");
    expect(send).not.toHaveBeenCalled();
    await expect(
      new OnboardingEmailProcessor(
        connection,
        { send },
        "a@example.test",
        "https://example.test",
        async () => {
          throw Error("provider");
        },
      ).process(c, "b@example.test"),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("requires a recent worker heartbeat and confirmed Auth email before promising email", async () => {
    const owner = randomUUID();
    await db.query(
      "insert into auth.users values($1,'synthetic@example.test',now())",
      [owner],
    );
    const pool = connection as unknown as Pool;
    expect(await emailNotificationReady(pool, owner)).toBe(false);
    await db.query(
      "insert into peragus_onboarding_email_workers values($1,now())",
      [owner],
    );
    expect(await emailNotificationReady(pool, owner)).toBe(true);
    await db.query(
      "update peragus_onboarding_email_workers set heartbeat_at=now()-interval '4 minutes' where owner_user_id=$1",
      [owner],
    );
    expect(await emailNotificationReady(pool, owner)).toBe(false);
  });
  it("uses Resend HTTPS with stable idempotency and hides provider error payloads", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "test-id" }));
    const sender = new ResendSender("re_synthetic", fetcher);
    const message = {
      from: "a@example.test",
      to: "b@example.test",
      subject: "test",
      text: "synthetic",
    };
    await sender.send("local-id", message);
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    expect(fetcher.mock.calls[0]![1].headers["Idempotency-Key"]).toBe(
      "peragus-onboarding-test/local-id",
    );
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetcher.mockResolvedValue(
      Response.json({ private: "do not log" }, { status: 429 }),
    );
    await expect(sender.send("local-id", message)).rejects.toThrow(
      "RESEND_SEND_UNCONFIRMED",
    );
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "onboarding_email_send_unconfirmed", reason: "HTTP_429" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("do not log");
    log.mockRestore();
  });
  it("renders branded HTML without exposing unescaped URL attributes", () => {
    for (const outcome of ["approved", "rejected", "action_required"] as const) {
      const message = notificationMessage(outcome, 'https://example.test/"x');
      expect(message.html).toContain("#0c1321");
      expect(message.html).toContain("&quot;x");
      expect(message.html).toContain("Ambiente de testes");
      expect(message.text).toContain("Ambiente de testes");
    }
  });
  it("validates disabled-by-default configuration, mandatory test allowlist and safe HTTPS links", () => {
    expect(notificationConfig({}).enabled).toBe(false);
    expect(() =>
      notificationConfig({ ONBOARDING_EMAILS_ENABLED: "true" }),
    ).toThrow();
    expect(() =>
      notificationConfig({
        ONBOARDING_EMAIL_ACCOUNT_URL: "https://user:pass@example.test",
      }),
    ).toThrow();
    expect(
      notificationMessage("approved", "https://example.test").text,
    ).toContain("não libera compras");
  });
});
