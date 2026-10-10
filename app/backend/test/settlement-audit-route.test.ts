import Fastify from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { buildApp } from "../src/app.js";
import {
  SettlementAuditNotFoundError,
  type SettlementAuditReader,
  type SettlementAuditView,
} from "../src/application/get-settlement-audit.js";
import { registerSettlementAuditRoutes } from "../src/routes/settlement-audit.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";
const applications: ReturnType<typeof Fastify>[] = [];

const view: SettlementAuditView = {
  generatedAt: new Date("2026-10-10T12:30:00.000Z"),
  settlement: {
    id: settlementId,
    requestId: "audit-route-test",
    corridorId: "ab".repeat(32),
    status: "paid_out",
    version: 8,
    sourceAmountBaseUnits: "500000000",
    destinationAmountBaseUnits: "89550000",
    expiresAt: new Date("2026-10-10T14:00:00.000Z"),
    createdAt: new Date("2026-10-10T12:00:00.000Z"),
    updatedAt: new Date("2026-10-10T12:20:00.000Z"),
  },
  onramp: {
    transferId: "ozav_tr_onramp",
    quoteId: "ozav_q_onramp",
    providerStatus: "completed",
    sourceLegStatus: "completed",
    destinationLegStatus: "completed",
    sourceAmountBrl: "500",
    targetAmountUsdt: "89.55",
    pixExpiresAt: new Date("2026-10-10T13:00:00.000Z"),
    createdAt: new Date("2026-10-10T12:00:30.000Z"),
    updatedAt: new Date("2026-10-10T12:03:00.000Z"),
    identityConsistent: true,
    events: [{
      eventId: "ozav_evt_onramp",
      eventType: "transfer.completed",
      occurredAt: "2026-10-10T12:03:00.000Z",
      contentHash: "a".repeat(64),
      providerStatus: "completed",
      sourceLegStatus: "completed",
      destinationLegStatus: "completed",
      sourceAmount: "500",
      sourceCurrency: "BRL",
      targetAmount: "89.55",
      targetCurrency: "USDT",
    }],
  },
  contingencyReserve: {
    status: "refunded",
    reservePda: "reserve-pda",
    vaultPda: "vault-pda",
    amountUsdt: "89.55",
    amountBaseUnits: "89550000",
    fallbackAfter: new Date("2026-10-10T12:05:00.000Z"),
    expiresAt: new Date("2026-10-10T14:00:00.000Z"),
    createSignature: "reserve-create-signature",
    resolutionAction: "refunded",
    resolutionSignature: "reserve-refund-signature",
    version: 1,
    createdAt: new Date("2026-10-10T12:00:40.000Z"),
    updatedAt: new Date("2026-10-10T12:04:00.000Z"),
  },
  solanaSettlement: {
    settlementPda: "settlement-pda",
    createSignature: "atomic-signature",
    executeSignature: "atomic-signature",
    atomicSignature: "atomic-signature",
    verified: true,
  },
  offramp: {
    transferId: "ozav_tr_offramp",
    quoteId: "ozav_q_offramp",
    payoutDestinationId: "ozav_pd_test",
    providerStatus: "completed",
    sourceLegStatus: "completed",
    destinationLegStatus: "completed",
    sourceAmountUsdt: "89.55",
    quotedTargetAmountBrl: "500",
    transferTargetAmountBrl: "499.98",
    createdAt: new Date("2026-10-10T12:10:00.000Z"),
    updatedAt: new Date("2026-10-10T12:20:00.000Z"),
    identityConsistent: true,
    events: [{
      eventId: "ozav_evt_offramp",
      eventType: "transfer.completed",
      occurredAt: "2026-10-10T12:20:00.000Z",
      contentHash: "b".repeat(64),
      providerStatus: "completed",
      sourceLegStatus: "completed",
      destinationLegStatus: "completed",
      sourceAmount: "89.55",
      sourceCurrency: "USDT",
      targetAmount: "499.98",
      targetCurrency: "BRL",
    }],
  },
  checks: {
    onrampCompleted: true,
    reserveResolved: true,
    solanaTransactionRecorded: true,
    offrampCompleted: true,
    settlementPaidOut: true,
    evidenceComplete: true,
  },
  warnings: [],
};

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((app) => app.close()),
  );
});

function readerReturning(
  value: SettlementAuditView,
): SettlementAuditReader {
  return {
    async execute() {
      return value;
    },
  };
}

async function appWith(
  reader?: SettlementAuditReader,
) {
  const app = Fastify();
  applications.push(app);
  await registerSettlementAuditRoutes(app, { reader });
  return app;
}

describe("GET /v1/settlements/:id/audit", () => {
  it("is registered by the main application", async () => {
    const app = await buildApp({
      settlementAuditReader: readerReturning(view),
    });
    applications.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/audit`,
    });

    expect(response.statusCode).toBe(200);
  });

  it("returns sanitized consolidated evidence", async () => {
    const app = await appWith(readerReturning(view));
    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/audit`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"])
      .toBe("no-store");
    expect(response.json()).toMatchObject({
      data: {
        generated_at: "2026-10-10T12:30:00.000Z",
        settlement: {
          id: settlementId,
          status: "paid_out",
        },
        onramp: {
          transfer_id: "ozav_tr_onramp",
          provider_status: "completed",
          event_count: 1,
        },
        contingency_reserve: {
          status: "refunded",
          resolution_action: "refunded",
        },
        solana_settlement: {
          atomic_signature: "atomic-signature",
          verified: true,
        },
        offramp: {
          transfer_id: "ozav_tr_offramp",
          provider_status: "completed",
          event_count: 1,
        },
        checks: {
          evidence_complete: true,
        },
        warnings: [],
      },
    });

    const body = response.body;
    expect(body).not.toContain("br_code");
    expect(body).not.toContain("qr_code");
    expect(body).not.toContain("customer_id");
    expect(body).not.toContain("wallet_id");
    expect(body).not.toContain("idempotency_key");
  });

  it("returns 404 for an unknown settlement", async () => {
    const app = await appWith({
      async execute(id) {
        throw new SettlementAuditNotFoundError(id);
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/audit`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("validates IDs before accessing storage", async () => {
    const app = await appWith(readerReturning(view));
    const response = await app.inject({
      method: "GET",
      url: "/v1/settlements/not-a-uuid/audit",
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 without database-backed storage", async () => {
    const app = await appWith();
    const response = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}/audit`,
    });

    expect(response.statusCode).toBe(503);
  });
});
