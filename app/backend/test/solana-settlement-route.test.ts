import Fastify, { type FastifyInstance } from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  SolanaSettlementExpiredError,
  SolanaSettlementNotFoundError,
  SolanaSettlementNotReadyError,
  type PrepareSolanaSettlementResult,
  type SolanaSettlementPreparer,
} from "../src/application/prepare-solana-settlement.js";
import { registerSolanaSettlementRoutes } from "../src/routes/solana-settlement.js";

const SETTLEMENT_ID =
  "b2a3b4fc-7a59-41ec-9ef6-b9b39b1400a1";

const applications: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((app) => app.close()),
  );
});

async function createApp(
  preparer?: SolanaSettlementPreparer,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  applications.push(app);
  await registerSolanaSettlementRoutes(app, { preparer });
  return app;
}

function preparedResult(
  replay = false,
): PrepareSolanaSettlementResult {
  return {
    settlementId: SETTLEMENT_ID,
    transactionBase64: "AQIDBA==",
    messageHash: "ab".repeat(32),
    settlementIdHex: "cd".repeat(32),
    settlementPda: "11111111111111111111111111111112",
    corridorPda: "11111111111111111111111111111113",
    configPda: "11111111111111111111111111111114",
    feePayer: "11111111111111111111111111111115",
    requiredExternalSigner:
      "11111111111111111111111111111115",
    recentBlockhash: "11111111111111111111111111111116",
    lastValidBlockHeight: 500_000,
    idempotentReplay: replay,
  };
}

describe("POST /v1/settlements/:id/solana/prepare", () => {
  it("returns a partially signed transaction for the acquirer", async () => {
    const app = await createApp({
      async execute() {
        return preparedResult();
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${SETTLEMENT_ID}/solana/prepare`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["idempotency-replayed"]).toBe(
      "false",
    );
    expect(response.json()).toMatchObject({
      data: {
        settlement_id: SETTLEMENT_ID,
        transaction_base64: "AQIDBA==",
        required_external_signer:
          "11111111111111111111111111111115",
      },
      meta: {
        idempotent_replay: false,
        broadcast_by: "acquirer",
      },
    });
  });

  it("returns 503 while Solana cosigning is disabled", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${SETTLEMENT_ID}/solana/prepare`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "SOLANA_COSIGNING_DISABLED",
      },
    });
  });

  it("rejects an invalid settlement ID", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/settlements/not-a-uuid/solana/prepare",
    });

    expect(response.statusCode).toBe(400);
  });

  it("maps a missing settlement to 404", async () => {
    const app = await createApp({
      async execute(id) {
        throw new SolanaSettlementNotFoundError(id);
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${SETTLEMENT_ID}/solana/prepare`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("maps a non-tokenized settlement to 409", async () => {
    const app = await createApp({
      async execute(id) {
        throw new SolanaSettlementNotReadyError(
          id,
          "awaiting_pix",
        );
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${SETTLEMENT_ID}/solana/prepare`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "SETTLEMENT_NOT_TOKENIZED",
        status: "awaiting_pix",
      },
    });
  });

  it("maps an expired settlement to 422", async () => {
    const app = await createApp({
      async execute(id) {
        throw new SolanaSettlementExpiredError(id);
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${SETTLEMENT_ID}/solana/prepare`,
    });

    expect(response.statusCode).toBe(422);
  });

  it("reports idempotent preparation replays", async () => {
    const app = await createApp({
      async execute() {
        return preparedResult(true);
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${SETTLEMENT_ID}/solana/prepare`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["idempotency-replayed"]).toBe(
      "true",
    );
    expect(response.json()).toMatchObject({
      meta: {
        idempotent_replay: true,
      },
    });
  });
});
