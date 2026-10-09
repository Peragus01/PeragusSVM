import Fastify from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { buildApp } from "../src/app.js";
import type {
  InitiateOzavOfframpResult,
  OzavOfframpInitiator,
} from "../src/application/initiate-ozav-offramp.js";
import {
  OzavOfframpInitiationError,
  OzavOfframpSettlementNotFoundError,
} from "../src/domain/ozav-offramp-intent.js";
import {
  OzavClientError,
} from "../src/providers/ozav-client.js";
import { registerOzavOfframpRoutes } from "../src/routes/ozav-offramp.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";
const payoutDestinationId = "ozav_pd_test";

const result: InitiateOzavOfframpResult = {
  settlementId,
  settlementStatus: "offramping",
  payoutDestinationId,
  sourceAmountUsdt: "89.55",
  quotedTargetAmountBrl: "500",
  transferTargetAmountBrl: "499.98",
  quoteId: "ozav_q_offramp",
  transferId: "ozav_tr_offramp",
  providerStatus: "converting",
  intentCreated: true,
  quoteCreated: true,
  transferReplayed: false,
};

const applications: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((app) => app.close()),
  );
});

async function appWith(
  initiator?: OzavOfframpInitiator,
) {
  const app = Fastify();
  applications.push(app);
  await registerOzavOfframpRoutes(app, { initiator });
  return app;
}

function initiatorReturning(
  value: InitiateOzavOfframpResult,
): OzavOfframpInitiator {
  return {
    async execute() {
      return value;
    },
  };
}

describe("POST /v1/settlements/:id/offramp", () => {
  it("is registered by the main application", async () => {
    const app = await buildApp({
      ozavOfframpInitiator: initiatorReturning(result),
    });
    applications.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${settlementId}/offramp`,
      payload: {
        payout_destination_id: payoutDestinationId,
      },
    });

    expect(response.statusCode).toBe(202);
  });

  it("returns persisted provider identifiers and amounts", async () => {
    const app = await appWith(initiatorReturning(result));

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${settlementId}/offramp`,
      payload: {
        payout_destination_id: payoutDestinationId,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["cache-control"])
      .toBe("no-store");
    expect(response.headers["idempotency-replayed"])
      .toBe("false");
    expect(response.json()).toEqual({
      data: {
        settlement_id: settlementId,
        settlement_status: "offramping",
        payout_destination_id: payoutDestinationId,
        quote_id: "ozav_q_offramp",
        transfer_id: "ozav_tr_offramp",
        provider_status: "converting",
        amounts: {
          source: {
            amount: "89.55",
            currency: "USDT",
          },
          quoted_target: {
            amount: "500",
            currency: "BRL",
          },
          transfer_target: {
            amount: "499.98",
            currency: "BRL",
          },
        },
      },
      meta: {
        idempotent_replay: false,
        intent_created: true,
        quote_created: true,
        environment: "test",
      },
    });
  });

  it("validates the payout destination before calling OZAV", async () => {
    const app = await appWith(initiatorReturning(result));

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${settlementId}/offramp`,
      payload: {
        payout_destination_id: "not-an-ozav-id",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 while sandbox writes are disabled", async () => {
    const app = await appWith();

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${settlementId}/offramp`,
      payload: {
        payout_destination_id: payoutDestinationId,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "OZAV_OFFRAMP_DISABLED" },
    });
  });

  it("maps missing and ineligible settlements safely", async () => {
    const missing = await appWith({
      async execute(input) {
        throw new OzavOfframpSettlementNotFoundError(
          input.settlementId,
        );
      },
    });
    const missingResponse = await missing.inject({
      method: "POST",
      url: `/v1/settlements/${settlementId}/offramp`,
      payload: {
        payout_destination_id: payoutDestinationId,
      },
    });
    expect(missingResponse.statusCode).toBe(404);

    const ineligible = await appWith({
      async execute() {
        throw new OzavOfframpInitiationError(
          "Cannot initiate OZAV off-ramp from tokenized",
        );
      },
    });
    const conflictResponse = await ineligible.inject({
      method: "POST",
      url: `/v1/settlements/${settlementId}/offramp`,
      payload: {
        payout_destination_id: payoutDestinationId,
      },
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({
      error: { code: "OZAV_OFFRAMP_NOT_READY" },
    });
  });

  it("does not expose provider error details", async () => {
    const app = await appWith({
      async execute() {
        throw new OzavClientError(
          "OZAV HTTP 503 secret provider detail",
          true,
          503,
        );
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/settlements/${settlementId}/offramp`,
      payload: {
        payout_destination_id: payoutDestinationId,
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("secret provider detail");
    expect(response.json()).toMatchObject({
      error: {
        code: "OZAV_PROVIDER_ERROR",
        retryable: true,
      },
    });
  });
});
