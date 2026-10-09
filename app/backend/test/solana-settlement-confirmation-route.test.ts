import { randomUUID } from "node:crypto";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { buildApp } from "../src/app.js";
import {
  SolanaConfirmationSettlementNotFoundError,
  SolanaTransactionMismatchError,
  SolanaTransactionNotConfirmedError,
  type SolanaSettlementConfirmer,
} from "../src/application/confirm-solana-settlement.js";

const applications: Awaited<
  ReturnType<typeof buildApp>
>[] = [];
const SETTLEMENT_ID = randomUUID();
const SIGNATURE = "1".repeat(88);

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((app) => app.close()),
  );
});

function createConfirmer(): SolanaSettlementConfirmer {
  return {
    execute: vi.fn(async () => ({
      settlementId: SETTLEMENT_ID,
      settlementPda:
        "11111111111111111111111111111112",
      signature: SIGNATURE,
      slot: 120,
      status: "settled" as const,
      version: 5,
      idempotentReplay: false,
    })),
  };
}

async function createApp(
  confirmer?: SolanaSettlementConfirmer,
) {
  const app = await buildApp({
    solanaSettlementConfirmer: confirmer,
  });
  applications.push(app);
  return app;
}

describe("POST /v1/settlements/:id/solana/confirm", () => {
  it("returns an on-chain verified settlement", async () => {
    const confirmer = createConfirmer();
    const app = await createApp(confirmer);

    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${SETTLEMENT_ID}/solana/confirm`,
      payload: {
        signature: SIGNATURE,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "no-store",
    );
    expect(response.headers["idempotency-replayed"]).toBe(
      "false",
    );
    expect(response.json()).toEqual({
      data: {
        settlement_id: SETTLEMENT_ID,
        settlement_pda:
          "11111111111111111111111111111112",
        signature: SIGNATURE,
        slot: 120,
        status: "settled",
        version: 5,
      },
      meta: {
        idempotent_replay: false,
        verified_on_chain: true,
      },
    });
    expect(confirmer.execute).toHaveBeenCalledWith(
      SETTLEMENT_ID,
      SIGNATURE,
    );
  });

  it("is disabled when no confirmer is configured", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${SETTLEMENT_ID}/solana/confirm`,
      payload: {
        signature: SIGNATURE,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe(
      "SOLANA_CONFIRMATION_DISABLED",
    );
  });

  it("rejects an invalid signature", async () => {
    const app = await createApp(createConfirmer());

    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${SETTLEMENT_ID}/solana/confirm`,
      payload: {
        signature: "not-a-signature",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("maps an unknown settlement to 404", async () => {
    const confirmer: SolanaSettlementConfirmer = {
      execute: vi.fn(async () => {
        throw new SolanaConfirmationSettlementNotFoundError(
          SETTLEMENT_ID,
        );
      }),
    };
    const app = await createApp(confirmer);

    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${SETTLEMENT_ID}/solana/confirm`,
      payload: {
        signature: SIGNATURE,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(
      "SETTLEMENT_NOT_FOUND",
    );
  });

  it("maps an unconfirmed transaction to 409", async () => {
    const confirmer: SolanaSettlementConfirmer = {
      execute: vi.fn(async () => {
        throw new SolanaTransactionNotConfirmedError(
          SIGNATURE,
        );
      }),
    };
    const app = await createApp(confirmer);

    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${SETTLEMENT_ID}/solana/confirm`,
      payload: {
        signature: SIGNATURE,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      "SOLANA_TRANSACTION_NOT_CONFIRMED",
    );
  });

  it("maps a mismatched transaction to 422", async () => {
    const confirmer: SolanaSettlementConfirmer = {
      execute: vi.fn(async () => {
        throw new SolanaTransactionMismatchError(
          "test mismatch",
        );
      }),
    };
    const app = await createApp(confirmer);

    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${SETTLEMENT_ID}/solana/confirm`,
      payload: {
        signature: SIGNATURE,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(
      "SOLANA_TRANSACTION_MISMATCH",
    );
  });
});
