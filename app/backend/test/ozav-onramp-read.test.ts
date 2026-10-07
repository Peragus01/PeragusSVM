import { describe, expect, it } from "vitest";

import {
  GetOzavOnrampService,
  OzavOnrampSettlementNotFoundError,
} from "../src/application/get-ozav-onramp.js";
import type {
  OzavOnrampIntent,
  OzavOnrampIntentRequest,
} from "../src/domain/ozav-onramp-intent.js";
import type {
  OzavOnrampBinding,
  OzavStoredEvent,
} from "../src/domain/ozav-onramp.js";
import type { Settlement } from "../src/domain/settlement.js";
import type { OzavEvent } from "../src/providers/ozav-client.js";
import type {
  OzavOnrampIntentRepository,
  SaveOzavPaymentInstructionsInput,
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

const settlement: Settlement = {
  id: settlementId,
  requestId: "read-onramp-test",
  requestPayloadHash: "a".repeat(64),
  requestPayload: {
    requestId: "read-onramp-test",
    corridorId: "ab".repeat(32),
    payerWallet: "11111111111111111111111111111112",
    recipientWallet:
      "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
    sourceAmount: "500000000",
    destinationAmount: "89550000",
    expiresAt: "2026-10-07T14:00:00.000Z",
  },
  corridorId: "ab".repeat(32),
  payerWallet: "11111111111111111111111111111112",
  recipientWallet:
    "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
  sourceAmount: "500000000",
  destinationAmount: "89550000",
  expiresAt: new Date("2026-10-07T14:00:00Z"),
  status: "awaiting_pix",
  version: 1,
  createdAt: new Date("2026-10-07T12:00:00Z"),
  updatedAt: new Date("2026-10-07T12:01:00Z"),
};

const intent: OzavOnrampIntent = {
  settlementId,
  customerId: "ozav_cus_test",
  walletId: "ozav_wal_test",
  sourceAmountBrl: "500",
  spreadBps: 0,
  idempotencyKey:
    "peragus_settlement_00000000000040008000000000000001",
  quoteId: "ozav_q_test",
  quoteTargetAmountUsdt: "89.55",
  paymentInstructions: {
    transferId: "ozav_tr_test",
    intentId: "sim_pix_test",
    brCode: "000201-test",
    qrCodeImage: "data:image/svg+xml,test",
    expiresAt: new Date("2026-10-07T13:00:00Z"),
  },
  createdAt: new Date("2026-10-07T12:00:00Z"),
  updatedAt: new Date("2026-10-07T12:01:00Z"),
};

const binding: OzavOnrampBinding = {
  settlementId,
  transferId: "ozav_tr_test",
  customerId: "ozav_cus_test",
  walletId: "ozav_wal_test",
  quoteId: "ozav_q_test",
};

class SettlementStore implements SettlementRepository {
  constructor(readonly value: Settlement | null) {}
  async createOrGet(
    candidate: Settlement,
  ): Promise<CreateOrGetSettlementResult> {
    return {
      settlement: this.value ?? candidate,
      created: this.value === null,
    };
  }
  async findById(id: string) {
    return this.value?.id === id ? this.value : null;
  }
  async findByRequestId(requestId: string) {
    return this.value?.requestId === requestId
      ? this.value
      : null;
  }
  async updateStatus(
    _input: UpdateSettlementStatusInput,
  ) {
    return null;
  }
}

class IntentStore
  implements OzavOnrampIntentRepository
{
  constructor(readonly value: OzavOnrampIntent | null) {}
  async reserve(_input: OzavOnrampIntentRequest) {
    throw new Error("not used");
  }
  async find(id: string) {
    return this.value?.settlementId === id
      ? this.value
      : null;
  }
  async saveQuote(_input: SaveOzavQuoteInput) {
    throw new Error("not used");
  }
  async savePaymentInstructions(
    _input: SaveOzavPaymentInstructionsInput,
  ) {
    throw new Error("not used");
  }
}

class OnrampStore implements OzavOnrampRepository {
  constructor(readonly value: OzavOnrampBinding | null) {}
  async createBinding(input: OzavOnrampBinding) {
    return { binding: input, created: true };
  }
  async findBinding(id: string) {
    return this.value?.settlementId === id
      ? this.value
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

function service(
  settlementValue: Settlement | null,
  intentValue: OzavOnrampIntent | null,
  bindingValue: OzavOnrampBinding | null,
) {
  return new GetOzavOnrampService({
    settlements: new SettlementStore(settlementValue),
    intents: new IntentStore(intentValue),
    onramps: new OnrampStore(bindingValue),
  });
}

describe("OZAV on-ramp read model", () => {
  it("reports a queued settlement before the worker reserves it", async () => {
    const result = await service(
      settlement,
      null,
      null,
    ).execute(settlementId);
    expect(result).toMatchObject({
      stage: "queued",
      ready: false,
      settlementStatus: "awaiting_pix",
      transferId: null,
    });
  });

  it("returns persisted Pix instructions only after binding", async () => {
    const result = await service(
      settlement,
      intent,
      binding,
    ).execute(settlementId);
    expect(result).toMatchObject({
      stage: "ready",
      ready: true,
      quoteId: "ozav_q_test",
      transferId: "ozav_tr_test",
      sourceAmountBrl: "500",
      quotedTargetAmountUsdt: "89.55",
      paymentInstructions: {
        intentId: "sim_pix_test",
        brCode: "000201-test",
      },
    });
  });

  it("does not expose instructions before their binding exists", async () => {
    const result = await service(
      settlement,
      intent,
      null,
    ).execute(settlementId);
    expect(result).toMatchObject({
      stage: "transfer_created",
      ready: false,
      transferId: "ozav_tr_test",
      paymentInstructions: null,
    });
  });

  it("rejects inconsistent transfer identities", async () => {
    await expect(service(
      settlement,
      intent,
      {
        ...binding,
        transferId: "ozav_tr_other",
      },
    ).execute(settlementId)).rejects.toThrow(
      "does not match its settlement binding",
    );
  });

  it("surfaces a missing settlement", async () => {
    await expect(service(
      null,
      null,
      null,
    ).execute(settlementId)).rejects.toBeInstanceOf(
      OzavOnrampSettlementNotFoundError,
    );
  });
});
