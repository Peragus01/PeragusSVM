import { describe, expect, it } from "vitest";

import {
  InitiateOzavOnrampService,
  type OzavOnrampWriter,
} from "../src/application/initiate-ozav-onramp.js";
import {
  normalizeOzavOnrampIntentRequest,
  OzavOnrampInitiationError,
  sameOzavOnrampIntentRequest,
  type OzavOnrampIntent,
  type OzavOnrampIntentRequest,
} from "../src/domain/ozav-onramp-intent.js";
import {
  sameOzavBinding,
  type OzavOnrampBinding,
  type OzavStoredEvent,
} from "../src/domain/ozav-onramp.js";
import type { Settlement } from "../src/domain/settlement.js";
import type {
  CreateOzavQuoteInput,
  CreateOzavTransferInput,
  OzavEvent,
  OzavQuote,
  OzavTransfer,
} from "../src/providers/ozav-client.js";
import type {
  OzavOnrampIntentRepository,
  SaveOzavQuoteInput,
} from "../src/repositories/ozav-onramp-intent-repository.js";
import type { OzavOnrampRepository } from "../src/repositories/ozav-onramp-repository.js";
import type {
  CreateOrGetSettlementResult,
  SettlementRepository,
  UpdateSettlementStatusInput,
} from "../src/repositories/settlement-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

function settlement(
  overrides: Partial<Settlement> = {},
): Settlement {
  const now = new Date("2026-10-07T12:00:00Z");
  const requestPayload = {
    requestId: "ozav-initiation-test",
    corridorId: "ab".repeat(32),
    payerWallet: "11111111111111111111111111111112",
    recipientWallet:
      "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
    sourceAmount: "500000000",
    destinationAmount: "89550000",
    expiresAt: "2026-10-07T14:00:00.000Z",
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
    status: "created",
    version: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class MemorySettlementRepository
  implements SettlementRepository
{
  constructor(public value: Settlement | null = settlement()) {}

  async createOrGet(
    candidate: Settlement,
  ): Promise<CreateOrGetSettlementResult> {
    this.value ??= candidate;
    return {
      settlement: this.value,
      created: this.value === candidate,
    };
  }

  async findById(id: string): Promise<Settlement | null> {
    return this.value?.id === id ? this.value : null;
  }

  async findByRequestId(
    requestId: string,
  ): Promise<Settlement | null> {
    return this.value?.requestId === requestId
      ? this.value
      : null;
  }

  async updateStatus(
    _input: UpdateSettlementStatusInput,
  ): Promise<Settlement | null> {
    return null;
  }
}

class MemoryIntentRepository
  implements OzavOnrampIntentRepository
{
  intent: OzavOnrampIntent | null = null;

  async reserve(input: OzavOnrampIntentRequest) {
    const request = normalizeOzavOnrampIntentRequest(input);
    if (this.intent) {
      if (!sameOzavOnrampIntentRequest(this.intent, request)) {
        throw new OzavOnrampInitiationError(
          "Settlement already has a different OZAV on-ramp intent",
        );
      }
      return { intent: this.intent, created: false };
    }
    const timestamp = new Date("2026-10-07T12:00:00Z");
    this.intent = {
      ...request,
      quoteId: null,
      quoteTargetAmountUsdt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return { intent: this.intent, created: true };
  }

  async find(id: string): Promise<OzavOnrampIntent | null> {
    return this.intent?.settlementId === id
      ? this.intent
      : null;
  }

  async saveQuote(
    input: SaveOzavQuoteInput,
  ): Promise<OzavOnrampIntent> {
    if (!this.intent) {
      throw new Error("Missing intent");
    }
    if (!this.intent.quoteId) {
      this.intent = {
        ...this.intent,
        quoteId: input.quoteId,
        quoteTargetAmountUsdt:
          input.quoteTargetAmountUsdt,
        updatedAt: input.updatedAt,
      };
    }
    return this.intent;
  }
}

class MemoryOnrampRepository
  implements OzavOnrampRepository
{
  binding: OzavOnrampBinding | null = null;

  async createBinding(input: OzavOnrampBinding) {
    if (this.binding && !sameOzavBinding(this.binding, input)) {
      throw new Error("different binding");
    }
    const created = this.binding === null;
    this.binding ??= input;
    return { binding: this.binding, created };
  }

  async findBinding(id: string) {
    return this.binding?.settlementId === id
      ? this.binding
      : null;
  }

  async recordEvent(
    _binding: OzavOnrampBinding,
    _event: OzavEvent,
  ) {
    return { inserted: false };
  }

  async listEvents(
    _id: string,
  ): Promise<OzavStoredEvent[]> {
    return [];
  }

  async markEventsProcessed() {
    return 0;
  }
}

class FakeOzavWriter implements OzavOnrampWriter {
  readonly quotes: CreateOzavQuoteInput[] = [];
  readonly transfers: CreateOzavTransferInput[] = [];
  failNextTransfer = false;
  quoteSourceAmount = "500.00";
  transferSourceAmount = "500";
  private readonly results =
    new Map<string, OzavTransfer>();

  async createQuote(
    input: CreateOzavQuoteInput,
  ): Promise<OzavQuote> {
    this.quotes.push(input);
    return {
      id: "ozav_q_test",
      customerId: input.customerId,
      rateType: "floating",
      rate: "0.1791",
      source: {
        amount: this.quoteSourceAmount,
        currency: "BRL",
      },
      target: {
        amount: "89.550000",
        currency: "USDT",
      },
      spreadBps: input.spreadBps,
      expiresAt: null,
      createdAt: "2026-10-07T12:00:00Z",
    };
  }

  async createTransfer(
    input: CreateOzavTransferInput,
  ) {
    this.transfers.push(input);
    if (this.failNextTransfer) {
      this.failNextTransfer = false;
      throw new Error("transient transfer failure");
    }
    const previous = this.results.get(input.idempotencyKey);
    if (previous) {
      return {
        transfer: previous,
        idempotentReplayed: true,
      };
    }
    const transfer: OzavTransfer = {
      id: "ozav_tr_test",
      status: "awaiting_payment",
      customerId: input.customerId,
      quoteId: input.quoteId,
      source: {
        type: "fiat_payment",
        currency: "BRL",
        rail: "pix",
        paymentInstructions: {
          intentId: "sim_pix_test",
          brCode: "000201-test",
          qrCodeImage: null,
          expiresAt: "2026-10-07T13:00:00Z",
        },
      },
      destination: {
        type: "wallet",
        walletId: input.walletId,
      },
      sourceLegStatus: "pending",
      destinationLegStatus: "pending",
      amounts: {
        source: {
          amount: this.transferSourceAmount,
          currency: "BRL",
        },
        target: {
          amount: "89.55",
          currency: "USDT",
        },
      },
    };
    this.results.set(input.idempotencyKey, transfer);
    return {
      transfer,
      idempotentReplayed: false,
    };
  }
}

function setup(
  value: Settlement = settlement(),
) {
  const client = new FakeOzavWriter();
  const intents = new MemoryIntentRepository();
  const onramps = new MemoryOnrampRepository();
  const settlements =
    new MemorySettlementRepository(value);
  const service = new InitiateOzavOnrampService({
    client,
    intents,
    onramps,
    settlements,
    customerId: "ozav_cus_test",
    walletId: "ozav_wal_test",
    sourceDecimals: 6,
    spreadBps: 0,
    now: () => new Date("2026-10-07T12:00:00Z"),
  });
  return {
    client,
    intents,
    onramps,
    settlements,
    service,
  };
}

describe("OZAV sandbox on-ramp initiation", () => {
  it("persists the quote before creating one transfer", async () => {
    const subject = setup();
    const result = await subject.service.execute(settlementId);

    expect(result).toMatchObject({
      transferId: "ozav_tr_test",
      quoteId: "ozav_q_test",
      sourceAmountBrl: "500",
      quotedTargetAmountUsdt: "89.55",
      bindingCreated: true,
      intentCreated: true,
      quoteCreated: true,
      transferReplayed: false,
      paymentInstructionsAvailable: true,
    });
    expect(subject.client.quotes).toEqual([{
      customerId: "ozav_cus_test",
      sourceAmountBrl: "500",
      spreadBps: 0,
    }]);
    expect(subject.client.transfers[0]).toMatchObject({
      customerId: "ozav_cus_test",
      walletId: "ozav_wal_test",
      quoteId: "ozav_q_test",
      idempotencyKey:
        "peragus_settlement_00000000000040008000000000000001",
      metadata: {
        project: "peragus",
        environment: "sandbox",
        settlement_id: settlementId,
      },
    });
  });

  it("does not write again after a binding exists", async () => {
    const subject = setup();
    await subject.service.execute(settlementId);
    const replay = await subject.service.execute(settlementId);

    expect(replay.bindingCreated).toBe(false);
    expect(subject.client.quotes).toHaveLength(1);
    expect(subject.client.transfers).toHaveLength(1);
  });

  it("resumes from the persisted quote after a transfer failure", async () => {
    const subject = setup();
    subject.client.failNextTransfer = true;

    await expect(
      subject.service.execute(settlementId),
    ).rejects.toThrow("transient transfer failure");
    expect(subject.intents.intent?.quoteId).toBe("ozav_q_test");

    const recovered =
      await subject.service.execute(settlementId);
    expect(recovered.bindingCreated).toBe(true);
    expect(subject.client.quotes).toHaveLength(1);
    expect(subject.client.transfers).toHaveLength(2);
  });

  it("uses the persisted quote after an interrupted worker", async () => {
    const subject = setup();
    const reserved = await subject.intents.reserve({
      settlementId,
      customerId: "ozav_cus_test",
      walletId: "ozav_wal_test",
      sourceAmountBrl: "500",
      spreadBps: 0,
      idempotencyKey:
        "peragus_settlement_00000000000040008000000000000001",
    });
    await subject.intents.saveQuote({
      settlementId,
      quoteId: "ozav_q_saved",
      quoteTargetAmountUsdt: "89.55",
      updatedAt: reserved.intent.updatedAt,
    });

    const result = await subject.service.execute(settlementId);
    expect(result.quoteId).toBe("ozav_q_saved");
    expect(subject.client.quotes).toHaveLength(0);
    expect(subject.client.transfers[0]?.quoteId)
      .toBe("ozav_q_saved");
  });

  it("rejects contract amounts below BRL cent precision", async () => {
    const subject = setup(settlement({
      sourceAmount: "500000001",
    }));
    await expect(subject.service.execute(settlementId))
      .rejects.toThrow("below BRL cent precision");
    expect(subject.client.quotes).toHaveLength(0);
  });

  it("rejects amounts below the configured sandbox minimum", async () => {
    const subject = setup(settlement({
      sourceAmount: "399000000",
    }));
    await expect(subject.service.execute(settlementId))
      .rejects.toThrow("minimum is BRL 400");
    expect(subject.client.quotes).toHaveLength(0);
  });

  it("rejects a quote that changes the source amount", async () => {
    const subject = setup();
    subject.client.quoteSourceAmount = "501";
    await expect(subject.service.execute(settlementId))
      .rejects.toThrow("quote does not match");
    expect(subject.client.transfers).toHaveLength(0);
    expect(subject.onramps.binding).toBeNull();
  });

  it("does not bind a transfer with a different source amount", async () => {
    const subject = setup();
    subject.client.transferSourceAmount = "499.99";
    await expect(subject.service.execute(settlementId))
      .rejects.toThrow("source amount does not match");
    expect(subject.onramps.binding).toBeNull();
  });

  it("rejects initiation after the settlement has advanced", async () => {
    const subject = setup(settlement({
      status: "pix_confirmed",
    }));
    await expect(subject.service.execute(settlementId))
      .rejects.toThrow("from pix_confirmed");
    expect(subject.client.quotes).toHaveLength(0);
  });
});
