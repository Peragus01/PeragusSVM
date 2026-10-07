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
) {
  const app = Fastify();
  applications.push(app);
  await registerOzavOnrampRoutes(app, {
    reader,
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

  it("returns persisted Pix data without provider credentials", async () => {
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
          intent_id: "sim_pix_test",
          br_code: "000201-test",
          expired: true,
        },
      },
    });
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
});
