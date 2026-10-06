import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

const validRequest = {
  request_id: "merchant-order-1001",
  corridor_id: "ab".repeat(32),
  payer_wallet: "11111111111111111111111111111112",
  recipient_wallet:
    "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
  source_amount: "25000000",
  destination_amount: "37500",
  expires_at: "2099-01-01T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("settlement API", () => {
  it("creates a settlement request", async () => {
    const app = await buildApp();
    applications.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: validRequest,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["idempotency-replayed"]).toBe("false");

    expect(response.json()).toMatchObject({
      data: {
        request_id: validRequest.request_id,
        corridor_id: validRequest.corridor_id,
        payer_wallet: validRequest.payer_wallet,
        recipient_wallet: validRequest.recipient_wallet,
        source_amount: validRequest.source_amount,
        destination_amount: validRequest.destination_amount,
        status: "created",
        version: 0,
      },
      meta: {
        idempotent_replay: false,
      },
    });
  });

  it("returns the original settlement for an identical retry", async () => {
    const app = await buildApp();
    applications.push(app);

    const first = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: validRequest,
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: validRequest,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotency-replayed"]).toBe("true");

    expect(second.json().data.id).toBe(first.json().data.id);
    expect(second.json().meta.idempotent_replay).toBe(true);
  });

  it("replays an existing request even after its expiration", async () => {
    let now = new Date("2030-01-01T00:00:00.000Z");

    const app = await buildApp({
      now: () => now,
    });
    applications.push(app);

    const expiringRequest = {
      ...validRequest,
      request_id: "expiring-idempotency-1001",
      expires_at: "2030-01-01T00:01:00.000Z",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: expiringRequest,
    });

    now = new Date("2030-01-01T00:02:00.000Z");

    const replay = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: expiringRequest,
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(replay.json().meta.idempotent_replay).toBe(true);
  });

  it("rejects reuse of request_id with a different payload", async () => {
    const app = await buildApp();
    applications.push(app);

    await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: validRequest,
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: {
        ...validRequest,
        destination_amount: "40000",
      },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message:
          "request_id was already used with a different payload",
      },
    });
  });

  it("returns a settlement by ID", async () => {
    const app = await buildApp();
    applications.push(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: validRequest,
    });

    const settlementId = created.json().data.id;

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/settlements/${settlementId}`,
    });

    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().data.id).toBe(settlementId);
    expect(fetched.json().data.status).toBe("created");
  });

  it("rejects invalid amounts", async () => {
    const app = await buildApp();
    applications.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: {
        ...validRequest,
        source_amount: "0",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an expired new request", async () => {
    const app = await buildApp({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    applications.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload: {
        ...validRequest,
        expires_at: "2029-12-31T23:59:59.000Z",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: "SETTLEMENT_EXPIRED",
        message: "expires_at must be in the future",
      },
    });
  });
});
