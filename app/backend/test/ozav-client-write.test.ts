import { describe, expect, it } from "vitest";

import {
  OzavClient,
  type OzavResponse,
  type OzavWriteRequest,
  type OzavWriteTransport,
} from "../src/providers/ozav-client.js";

const apiKey = "ozav_sk_test_fake_for_write_tests";

const quoteResponse = {
  id: "ozav_q_test",
  object: "quote",
  customer_id: "ozav_cus_test",
  rate_type: "floating",
  rate: "0.179100",
  source: {
    amount: "500.00",
    currency: "BRL",
  },
  target: {
    amount: "89.550000",
    currency: "USDT",
  },
  exchange_conditions: {
    spread_bps: 0,
    rate_without_spread: "0.1791",
  },
  expires_at: null,
  created_at: "2026-10-07T12:00:00Z",
};

const transferResponse = {
  id: "ozav_tr_test",
  object: "transfer",
  customer_id: "ozav_cus_test",
  quote_id: "ozav_q_test",
  status: "awaiting_payment",
  source: {
    type: "fiat_payment",
    currency: "BRL",
    rail: "pix",
    payment_instructions: {
      rail: "pix",
      intent_id: "sim_pix_test",
      br_code: "000201-test",
      qr_code_image: "data:image/svg+xml,test",
      expires_at: "2026-10-07T13:00:00Z",
    },
  },
  destination: {
    type: "wallet",
    wallet_id: "ozav_wal_test",
  },
  source_leg: { status: "pending" },
  destination_leg: { status: "pending" },
  amounts: {
    source: { amount: "500", currency: "BRL" },
    target: { amount: "89.55", currency: "USDT" },
  },
};

function setup(responses: OzavResponse[]) {
  const requests: OzavWriteRequest[] = [];
  const delays: number[] = [];
  const writeTransport: OzavWriteTransport =
    async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    };
  return {
    client: new OzavClient({
      apiKey,
      writeTransport,
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }),
    requests,
    delays,
  };
}

describe("OZAV sandbox write client", () => {
  it("creates a Solana USDT quote with explicit zero spread", async () => {
    const subject = setup([{
      statusCode: 201,
      body: quoteResponse,
    }]);
    const quote = await subject.client.createQuote({
      customerId: "ozav_cus_test",
      sourceAmountBrl: "500.00",
      spreadBps: 0,
    });
    expect(quote).toMatchObject({
      id: "ozav_q_test",
      customerId: "ozav_cus_test",
      rate: "0.179100",
      spreadBps: 0,
    });
    expect(subject.requests).toEqual([{
      path: "/v2/quotes",
      body: {
        customer_id: "ozav_cus_test",
        source: {
          currency: "BRL",
          amount: "500.00",
        },
        target: {
          currency: "USDT",
          chain: "solana",
        },
        source_rail: "pix",
        spread_bps: 0,
      },
    }]);
  });

  it("creates an idempotent Pix on-ramp transfer", async () => {
    const subject = setup([{
      statusCode: 201,
      body: transferResponse,
      headers: {
        "idempotent-replayed": "true",
      },
    }]);
    const result = await subject.client.createTransfer({
      customerId: "ozav_cus_test",
      walletId: "ozav_wal_test",
      quoteId: "ozav_q_test",
      idempotencyKey:
        "peragus_settlement_00000000000040008000000000000001",
      metadata: {
        settlement_id:
          "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(result.idempotentReplayed).toBe(true);
    expect(result.transfer.source.paymentInstructions)
      .toMatchObject({
        intentId: "sim_pix_test",
        brCode: "000201-test",
      });
    expect(subject.requests[0]).toMatchObject({
      path: "/v2/transfers",
      idempotencyKey:
        "peragus_settlement_00000000000040008000000000000001",
      body: {
        customer_id: "ozav_cus_test",
        quote_id: "ozav_q_test",
        source: {
          type: "fiat_payment",
          currency: "BRL",
          rail: "pix",
        },
        destination: {
          type: "wallet",
          wallet_id: "ozav_wal_test",
        },
      },
    });
  });

  it("retries an idempotency request still being processed", async () => {
    const subject = setup([
      { statusCode: 202, body: null },
      { statusCode: 201, body: transferResponse },
    ]);
    await subject.client.createTransfer({
      customerId: "ozav_cus_test",
      walletId: "ozav_wal_test",
      quoteId: "ozav_q_test",
      idempotencyKey:
        "peragus_settlement_00000000000040008000000000000001",
      metadata: {},
    });
    expect(subject.requests).toHaveLength(2);
    expect(subject.delays).toEqual([1_000]);
  });

  it("accepts an asynchronous sandbox payment simulation", async () => {
    const subject = setup([{
      statusCode: 202,
      body: null,
    }]);

    await expect(
      subject.client.simulateTransfer("ozav_tr_test"),
    ).resolves.toBeUndefined();
    expect(subject.requests).toEqual([{
      path: "/v2/transfers/ozav_tr_test/simulate",
      body: {},
    }]);
    expect(subject.delays).toEqual([]);
  });

  it("does not send malformed idempotency keys", async () => {
    const subject = setup([]);
    await expect(subject.client.createTransfer({
      customerId: "ozav_cus_test",
      walletId: "ozav_wal_test",
      quoteId: "ozav_q_test",
      idempotencyKey: "short",
      metadata: {},
    })).rejects.toThrow("Invalid OZAV transfer input");
    expect(subject.requests).toHaveLength(0);
  });
});
