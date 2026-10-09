import { describe, expect, it } from "vitest";

import {
  InitiateOzavOfframpService,
  type OzavOfframpWriter,
  type SettlementStatusTransitioner,
} from "../src/application/initiate-ozav-offramp.js";
import {
  normalizeOzavOfframpBrlAmount,
  normalizeOzavOfframpIntentRequest,
  normalizeOzavTransferStatus,
  normalizeOzavUsdtAmount,
  OzavOfframpInitiationError,
  sameOzavOfframpIntentRequest,
  type OzavOfframpIntent,
  type OzavOfframpIntentRequest,
} from "../src/domain/ozav-offramp-intent.js";
import type { Settlement } from "../src/domain/settlement.js";
import type {
  CreateOzavOfframpQuoteInput,
  CreateOzavOfframpTransferInput,
  OzavPayoutDestination,
  OzavQuote,
  OzavTransfer,
} from "../src/providers/ozav-client.js";
import type {
  OzavOfframpIntentRepository,
  SaveOzavOfframpQuoteInput,
  SaveOzavOfframpTransferInput,
} from "../src/repositories/ozav-offramp-intent-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";
const payoutDestinationId = "ozav_pd_test";

function settlement(
  overrides: Partial<Settlement> = {},
): Settlement {
  const timestamp = new Date("2026-10-08T12:00:00Z");
  const requestPayload = {
    requestId: "offramp-test",
    corridorId: "ab".repeat(32),
    payerWallet: "11111111111111111111111111111112",
    recipientWallet:
      "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
    sourceAmount: "500000000",
    destinationAmount: "89550000",
    expiresAt: "2026-10-08T14:00:00.000Z",
  };

  return {
    id: settlementId,
    requestId: requestPayload.requestId,
    requestPayloadHash: "a".repeat(64),
    requestPayload,
    corridorId: requestPayload.corridorId,
    payerWallet: requestPayload.payerWallet,
    recipientWallet: requestPayload.recipientWallet,
    sourceAmount: requestPayload.sourceAmount,
    destinationAmount: requestPayload.destinationAmount,
    expiresAt: new Date(requestPayload.expiresAt),
    status: "settled",
    version: 6,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

class MemoryIntentRepository
  implements OzavOfframpIntentRepository
{
  intent: OzavOfframpIntent | null = null;

  async reserve(input: OzavOfframpIntentRequest) {
    const request = normalizeOzavOfframpIntentRequest(input);

    if (this.intent) {
      if (!sameOzavOfframpIntentRequest(this.intent, request)) {
        throw new OzavOfframpInitiationError(
          "different intent",
        );
      }
      return { intent: this.intent, created: false };
    }

    const timestamp = new Date("2026-10-08T12:00:00Z");
    this.intent = {
      ...request,
      quoteId: null,
      quoteTargetAmountBrl: null,
      transferId: null,
      providerStatus: null,
      transferSourceAmountUsdt: null,
      transferTargetAmountBrl: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return { intent: this.intent, created: true };
  }

  async find(id: string) {
    return this.intent?.settlementId === id
      ? this.intent
      : null;
  }

  async saveQuote(input: SaveOzavOfframpQuoteInput) {
    if (!this.intent) throw new Error("Missing intent");

    if (!this.intent.quoteId) {
      this.intent = {
        ...this.intent,
        quoteId: input.quoteId,
        quoteTargetAmountBrl:
          normalizeOzavOfframpBrlAmount(
            input.quoteTargetAmountBrl,
          ),
        updatedAt: input.updatedAt,
      };
    }

    return this.intent;
  }

  async saveTransfer(
    input: SaveOzavOfframpTransferInput,
  ) {
    if (!this.intent) throw new Error("Missing intent");

    if (!this.intent.transferId) {
      this.intent = {
        ...this.intent,
        transferId: input.transferId,
        providerStatus: normalizeOzavTransferStatus(
          input.providerStatus,
        ),
        transferSourceAmountUsdt:
          normalizeOzavUsdtAmount(input.sourceAmountUsdt),
        transferTargetAmountBrl:
          normalizeOzavOfframpBrlAmount(
            input.targetAmountBrl,
          ),
        updatedAt: input.updatedAt,
      };
    }

    return this.intent;
  }
}

class MemorySettlements {
  constructor(public value: Settlement | null = settlement()) {}

  async findById(id: string) {
    return this.value?.id === id ? this.value : null;
  }
}

class MemoryTransitioner
  implements SettlementStatusTransitioner
{
  readonly calls: string[] = [];

  constructor(private readonly settlements: MemorySettlements) {}

  async execute(input: {
    settlementId: string;
    nextStatus: "offramping";
  }): Promise<Settlement> {
    this.calls.push(input.nextStatus);
    const current = await this.settlements.findById(
      input.settlementId,
    );

    if (!current || current.status !== "settled") {
      throw new Error("concurrent transition");
    }

    this.settlements.value = {
      ...current,
      status: "offramping",
      version: current.version + 1,
    };

    return this.settlements.value;
  }
}

class FakeOzavOfframpWriter implements OzavOfframpWriter {
  readonly quoteInputs: CreateOzavOfframpQuoteInput[] = [];
  readonly transferInputs:
    CreateOzavOfframpTransferInput[] = [];
  getTransferCalls = 0;
  getDestinationCalls = 0;
  failNextTransfer = false;
  payoutCustomerId = "ozav_cus_test";
  offRampTransferSourceAmount = "89.55";
  private readonly transfers =
    new Map<string, OzavTransfer>();

  async getTransfer(): Promise<OzavTransfer> {
    this.getTransferCalls += 1;
    return {
      id: "ozav_tr_onramp",
      status: "completed",
      customerId: "ozav_cus_test",
      quoteId: "ozav_q_onramp",
      source: {
        type: "fiat_payment",
        currency: "BRL",
        rail: "pix",
      },
      destination: {
        type: "wallet",
        walletId: "ozav_wal_test",
      },
      sourceLegStatus: "completed",
      destinationLegStatus: "completed",
      amounts: {
        source: { amount: "500", currency: "BRL" },
        target: { amount: "89.55", currency: "USDT" },
      },
    };
  }

  async getPayoutDestination(
    id: string,
  ): Promise<OzavPayoutDestination> {
    this.getDestinationCalls += 1;
    return {
      id,
      customerId: this.payoutCustomerId,
      currency: "BRL",
      rail: "pix",
      status: "active",
    };
  }

  async createOfframpQuote(
    input: CreateOzavOfframpQuoteInput,
  ): Promise<OzavQuote> {
    this.quoteInputs.push(input);
    return {
      id: "ozav_q_offramp",
      customerId: input.customerId,
      rateType: "floating",
      rate: "5.583472",
      source: {
        amount: input.sourceAmountUsdt,
        currency: "USDT",
      },
      target: {
        amount: "500.00",
        currency: "BRL",
      },
      spreadBps: input.spreadBps,
      expiresAt: null,
      createdAt: "2026-10-08T12:00:00Z",
    };
  }

  async createOfframpTransfer(
    input: CreateOzavOfframpTransferInput,
  ) {
    this.transferInputs.push(input);

    if (this.failNextTransfer) {
      this.failNextTransfer = false;
      throw new Error("transient transfer failure");
    }

    const existing = this.transfers.get(
      input.idempotencyKey,
    );
    if (existing) {
      return {
        transfer: existing,
        idempotentReplayed: true,
      };
    }

    const transfer: OzavTransfer = {
      id: "ozav_tr_offramp",
      status: "converting",
      customerId: input.customerId,
      quoteId: input.quoteId,
      source: {
        type: "wallet",
        currency: "USDT",
        rail: null,
        walletId: input.walletId,
      },
      destination: {
        type: "payout_destination",
        walletId: null,
        payoutDestinationId:
          input.payoutDestinationId,
      },
      sourceLegStatus: "completed",
      destinationLegStatus: "pending",
      amounts: {
        source: {
          amount: this.offRampTransferSourceAmount,
          currency: "USDT",
        },
        target: { amount: "500", currency: "BRL" },
      },
    };
    this.transfers.set(input.idempotencyKey, transfer);

    return {
      transfer,
      idempotentReplayed: false,
    };
  }
}

function setup(value: Settlement | null = settlement()) {
  const client = new FakeOzavOfframpWriter();
  const intents = new MemoryIntentRepository();
  const settlements = new MemorySettlements(value);
  const transitioner = new MemoryTransitioner(settlements);
  const service = new InitiateOzavOfframpService({
    client,
    intents,
    onramps: {
      async findBinding(id) {
        return id === settlementId
          ? {
              settlementId,
              transferId: "ozav_tr_onramp",
              customerId: "ozav_cus_test",
              walletId: "ozav_wal_test",
              quoteId: "ozav_q_onramp",
            }
          : null;
      },
    },
    settlements,
    transitioner,
    customerId: "ozav_cus_test",
    walletId: "ozav_wal_test",
    spreadBps: 0,
    now: () => new Date("2026-10-08T12:00:00Z"),
  });

  return {
    client,
    intents,
    settlements,
    transitioner,
    service,
  };
}

describe("OZAV sandbox off-ramp initiation", () => {
  it("creates one payout transfer and enters off-ramping", async () => {
    const subject = setup();

    const result = await subject.service.execute({
      settlementId,
      payoutDestinationId,
    });

    expect(result).toMatchObject({
      settlementId,
      settlementStatus: "offramping",
      payoutDestinationId,
      sourceAmountUsdt: "89.55",
      quotedTargetAmountBrl: "500",
      transferTargetAmountBrl: "500",
      quoteId: "ozav_q_offramp",
      transferId: "ozav_tr_offramp",
      providerStatus: "converting",
      intentCreated: true,
      quoteCreated: true,
      transferReplayed: false,
    });
    expect(subject.transitioner.calls).toEqual([
      "offramping",
    ]);
    expect(subject.client.quoteInputs).toEqual([{
      customerId: "ozav_cus_test",
      sourceAmountUsdt: "89.55",
      spreadBps: 0,
    }]);
    expect(subject.client.transferInputs[0]).toMatchObject({
      payoutDestinationId,
      idempotencyKey:
        "peragus_offramp_00000000000040008000000000000001",
      metadata: {
        flow: "offramp",
        settlement_id: settlementId,
      },
    });
  });

  it("replays the persisted transfer without another OZAV write", async () => {
    const subject = setup();
    await subject.service.execute({
      settlementId,
      payoutDestinationId,
    });

    const replay = await subject.service.execute({
      settlementId,
      payoutDestinationId,
    });

    expect(replay.transferReplayed).toBe(true);
    expect(replay.intentCreated).toBe(false);
    expect(subject.client.quoteInputs).toHaveLength(1);
    expect(subject.client.transferInputs).toHaveLength(1);
    expect(subject.client.getTransferCalls).toBe(1);
    expect(subject.transitioner.calls).toHaveLength(1);
  });

  it("resumes from a persisted quote after a transfer failure", async () => {
    const subject = setup();
    subject.client.failNextTransfer = true;

    await expect(subject.service.execute({
      settlementId,
      payoutDestinationId,
    })).rejects.toThrow("transient transfer failure");

    const recovered = await subject.service.execute({
      settlementId,
      payoutDestinationId,
    });

    expect(recovered.quoteCreated).toBe(false);
    expect(subject.client.quoteInputs).toHaveLength(1);
    expect(subject.client.transferInputs).toHaveLength(2);
    expect(subject.settlements.value?.status)
      .toBe("offramping");
  });

  it("does not start before Solana settlement is confirmed", async () => {
    const subject = setup(settlement({ status: "tokenized" }));

    await expect(subject.service.execute({
      settlementId,
      payoutDestinationId,
    })).rejects.toThrow("from tokenized");

    expect(subject.client.quoteInputs).toHaveLength(0);
    expect(subject.client.transferInputs).toHaveLength(0);
  });

  it("rejects a payout destination owned by another customer", async () => {
    const subject = setup();
    subject.client.payoutCustomerId = "ozav_cus_other";

    await expect(subject.service.execute({
      settlementId,
      payoutDestinationId,
    })).rejects.toThrow("active BRL Pix destination");

    expect(subject.client.quoteInputs).toHaveLength(0);
  });

  it("does not bind a transfer with a different amount", async () => {
    const subject = setup();
    subject.client.offRampTransferSourceAmount = "89.54";

    await expect(subject.service.execute({
      settlementId,
      payoutDestinationId,
    })).rejects.toThrow("does not match");

    expect(subject.intents.intent?.transferId).toBeNull();
    expect(subject.settlements.value?.status).toBe("settled");
  });

  it("prevents a replay from changing payout destination", async () => {
    const subject = setup();
    await subject.service.execute({
      settlementId,
      payoutDestinationId,
    });

    await expect(subject.service.execute({
      settlementId,
      payoutDestinationId: "ozav_pd_other",
    })).rejects.toThrow("different OZAV payout destination");

    expect(subject.client.transferInputs).toHaveLength(1);
  });
});
