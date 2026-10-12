import Fastify from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { buildApp } from "../src/app.js";
import {
  OzavOnrampSettlementNotFoundError,
  type OzavOnrampReader,
  type OzavOnrampView,
} from "../src/application/get-ozav-onramp.js";
import type { SandboxPixPaymentSimulator } from "../src/application/simulate-sandbox-pix-payment.js";
import { registerOzavOnrampRoutes } from "../src/routes/ozav-onramp.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

const applications: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((app) => app.close()),
  );
});

async function appWith(
  reader?: OzavOnrampReader,
  sandboxPaymentSimulator?: SandboxPixPaymentSimulator,
) {
  const app = Fastify();
  applications.push(app);
  await registerOzavOnrampRoutes(app, {
    reader,
    sandboxPaymentSimulator,
    now: () => new Date("2026-10-07T13:01:00Z"),
  });
  return app;
}

function readerReturning(
  value: OzavOnrampView,
): OzavOnrampReader {
  return {
    async execute() {
      return value;
    },
  };
}

describe("GET /v1/settlements/:id/onramp", () => {
  it("is registered by the main application", async () => {
    const app = await buildApp({
      ozavOnrampReader: readerReturning({
        settlementId,
        settlementStatus: "created",
        stage: "queued",
        ready: false,
        quoteId: null,
        transferId: null,
        sourceAmountBrl: null,
        quotedTargetAmountUsdt: null,
        paymentInstructions: null,
      }),
    });
    applications.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/onramp`,
    });
    expect(response.statusCode).toBe(202);
  });

  it("returns 202 while orchestration is pending", async () => {
    const app = await appWith(readerReturning({
      settlementId,
      settlementStatus: "created",
      stage: "queued",
      ready: false,
      quoteId: null,
      transferId: null,
      sourceAmountBrl: null,
      quotedTargetAmountUsdt: null,
      paymentInstructions: null,
    }));
    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/onramp`,
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers["cache-control"])
      .toBe("no-store");
    expect(response.json()).toMatchObject({
      data: {
        stage: "queued",
        ready: false,
        pix: null,
      },
    });
  });

  it("returns Pix readiness without payment payloads", async () => {
    const app = await appWith(readerReturning({
      settlementId,
      settlementStatus: "awaiting_pix",
      stage: "ready",
      ready: true,
      quoteId: "ozav_q_test",
      transferId: "ozav_tr_test",
      sourceAmountBrl: "500",
      quotedTargetAmountUsdt: "89.55",
      paymentInstructions: {
        transferId: "ozav_tr_test",
        intentId: "sim_pix_test",
        brCode: "000201-test",
        qrCodeImage: "data:image/svg+xml,test",
        expiresAt:
          new Date("2026-10-07T13:00:00Z"),
      },
    }));
    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/onramp`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        settlement_id: settlementId,
        settlement_status: "awaiting_pix",
        quote_id: "ozav_q_test",
        transfer_id: "ozav_tr_test",
        pix: {
          expired: true,
        },
      },
    });
    expect(response.body).not.toContain("000201-test");
    expect(response.body).not.toContain("data:image");
  });

  it("returns 404 for an unknown settlement", async () => {
    const app = await appWith({
      async execute(id) {
        throw new OzavOnrampSettlementNotFoundError(id);
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/onramp`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("validates IDs before accessing storage", async () => {
    const app = await appWith(readerReturning({
      settlementId,
      settlementStatus: "created",
      stage: "queued",
      ready: false,
      quoteId: null,
      transferId: null,
      sourceAmountBrl: null,
      quotedTargetAmountUsdt: null,
      paymentInstructions: null,
    }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/settlements/not-a-uuid/onramp",
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 503 when database-backed storage is absent", async () => {
    const app = await appWith();
    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/onramp`,
    });
    expect(response.statusCode).toBe(503);
  });

  it("keeps sandbox payment controls disabled by default", async () => {
    const app = await appWith();
    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${settlementId}/onramp/simulate-payment`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "SANDBOX_DEMO_DISABLED" },
    });
  });

  it("accepts an explicitly enabled sandbox payment", async () => {
    const calls: string[] = [];
    const app = await appWith(undefined, {
      async execute(id) {
        calls.push(id);
        return {
          settlementId: id,
          settlementStatus: "awaiting_pix",
          accepted: true,
          idempotentReplay: false,
          reconciliationScheduled: true,
        };
      },
    });
    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${settlementId}/onramp/simulate-payment`,
    });

    expect(response.statusCode).toBe(202);
    expect(calls).toEqual([settlementId]);
    expect(response.json()).toMatchObject({
      data: {
        settlement_id: settlementId,
        accepted: true,
        reconciliation_scheduled: true,
      },
      meta: {
        idempotent_replay: false,
        environment: "sandbox",
      },
    });
  });
});
