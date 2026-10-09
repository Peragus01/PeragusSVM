import { describe, expect, it } from "vitest";

import {
  OzavClient,
  type OzavResponse,
  type OzavTransport,
  type OzavWriteRequest,
  type OzavWriteTransport,
} from "../src/providers/ozav-client.js";

const apiKey = "ozav_sk_test_offramp_client";

const payoutDestinationResponse = {
  id: "ozav_pd_test",
  object: "payout_destination",
  customer_id: "ozav_cus_test",
  currency: "BRL",
  rail: "pix",
  status: "active",
};

const quoteResponse = {
  id: "ozav_q_offramp",
  object: "quote",
  customer_id: "ozav_cus_test",
  rate_type: "floating",
  rate: "5.583472",
  source: {
    amount: "89.55",
    currency: "USDT",
  },
  target: {
    amount: "500.00",
    currency: "BRL",
  },
  exchange_conditions: {
    spread_bps: 0,
  },
  expires_at: null,
  created_at: "2026-10-08T12:00:00Z",
};

const transferResponse = {
  id: "ozav_tr_offramp",
  object: "transfer",
  customer_id: "ozav_cus_test",
  quote_id: "ozav_q_offramp",
  status: "converting",
  source: {
    type: "wallet",
    wallet_id: "ozav_wal_test",
    currency: "USDT",
    chain: "solana",
  },
  destination: {
    type: "payout_destination",
    payout_destination_id: "ozav_pd_test",
  },
  source_leg: { status: "completed" },
  destination_leg: { status: "pending" },
  amounts: {
    source: { amount: "89.55", currency: "USDT" },
    target: { amount: "500", currency: "BRL" },
  },
};

function setup(options: {
  reads?: OzavResponse[];
  writes?: OzavResponse[];
}) {
  const readPaths: string[] = [];
  const writeRequests: OzavWriteRequest[] = [];
  const transport: OzavTransport = async (path) => {
    readPaths.push(path);
    const response = options.reads?.shift();
    if (!response) throw new Error("Unexpected read");
    return response;
  };
  const writeTransport: OzavWriteTransport =
    async (request) => {
      writeRequests.push(request);
      const response = options.writes?.shift();
      if (!response) throw new Error("Unexpected write");
      return response;
    };

  return {
    client: new OzavClient({
      apiKey,
      transport,
      writeTransport,
      attempts: 1,
    }),
    readPaths,
    writeRequests,
  };
}

describe("OZAV sandbox off-ramp client", () => {
  it("reads and validates a BRL Pix payout destination", async () => {
    const subject = setup({
      reads: [{
        statusCode: 200,
        body: payoutDestinationResponse,
      }],
    });

    const destination =
      await subject.client.getPayoutDestination(
        "ozav_pd_test",
      );

    expect(destination).toEqual({
      id: "ozav_pd_test",
      customerId: "ozav_cus_test",
      currency: "BRL",
      rail: "pix",
      status: "active",
    });
    expect(subject.readPaths).toEqual([
      "/v2/payout-destinations/ozav_pd_test",
    ]);
  });

  it("creates a USDT Solana to BRL Pix quote", async () => {
    const subject = setup({
      writes: [{
        statusCode: 201,
        body: quoteResponse,
      }],
    });

    const quote = await subject.client.createOfframpQuote({
      customerId: "ozav_cus_test",
      sourceAmountUsdt: "89.55",
      spreadBps: 0,
    });

    expect(quote).toMatchObject({
      id: "ozav_q_offramp",
      source: {
        amount: "89.55",
        currency: "USDT",
      },
      target: {
        amount: "500.00",
        currency: "BRL",
      },
    });
    expect(subject.writeRequests).toEqual([{
      path: "/v2/quotes",
      body: {
        customer_id: "ozav_cus_test",
        source: {
          currency: "USDT",
          amount: "89.55",
          chain: "solana",
        },
        target: {
          currency: "BRL",
        },
        destination_rail: "pix",
        spread_bps: 0,
      },
    }]);
  });

  it("creates an idempotent wallet to payout transfer", async () => {
    const subject = setup({
      writes: [{
        statusCode: 201,
        body: transferResponse,
        headers: {
          "idempotent-replayed": "true",
        },
      }],
    });

    const result =
      await subject.client.createOfframpTransfer({
        customerId: "ozav_cus_test",
        walletId: "ozav_wal_test",
        payoutDestinationId: "ozav_pd_test",
        quoteId: "ozav_q_offramp",
        idempotencyKey:
          "peragus_offramp_00000000000040008000000000000001",
        metadata: {
          settlement_id:
            "00000000-0000-4000-8000-000000000001",
        },
      });

    expect(result.idempotentReplayed).toBe(true);
    expect(result.transfer).toMatchObject({
      source: {
        type: "wallet",
        walletId: "ozav_wal_test",
      },
      destination: {
        type: "payout_destination",
        payoutDestinationId: "ozav_pd_test",
      },
    });
    expect(subject.writeRequests[0]).toMatchObject({
      path: "/v2/transfers",
      idempotencyKey:
        "peragus_offramp_00000000000040008000000000000001",
      body: {
        source: {
          type: "wallet",
          wallet_id: "ozav_wal_test",
          currency: "USDT",
          chain: "solana",
        },
        destination: {
          type: "payout_destination",
          payout_destination_id: "ozav_pd_test",
        },
      },
    });
  });

  it("rejects malformed payout identifiers before writing", async () => {
    const subject = setup({ writes: [] });

    await expect(
      subject.client.createOfframpTransfer({
        customerId: "ozav_cus_test",
        walletId: "ozav_wal_test",
        payoutDestinationId: "wrong",
        quoteId: "ozav_q_offramp",
        idempotencyKey:
          "peragus_offramp_00000000000040008000000000000001",
        metadata: {},
      }),
    ).rejects.toThrow("Invalid OZAV response");

    expect(subject.writeRequests).toHaveLength(0);
  });
});
