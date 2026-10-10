import { describe, expect, it } from "vitest";

import {
  GetSettlementAuditService,
  SettlementAuditNotFoundError,
  type GetSettlementAuditOptions,
} from "../src/application/get-settlement-audit.js";
import type { OzavOfframpIntent } from "../src/domain/ozav-offramp-intent.js";
import type { OzavOnrampIntent } from "../src/domain/ozav-onramp-intent.js";
import type {
  OzavOnrampBinding,
  OzavStoredEvent,
} from "../src/domain/ozav-onramp.js";
import type { Settlement } from "../src/domain/settlement.js";
import type { SolanaContingencyReserve } from "../src/repositories/solana-contingency-reserve-repository.js";
import type { SolanaSettlementConfirmationState } from "../src/repositories/solana-settlement-confirmation-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";
const firstEventAt = "2026-10-10T12:02:00.000Z";
const completedAt = "2026-10-10T12:03:00.000Z";

const settlement: Settlement = {
  id: settlementId,
  requestId: "audit-test",
  requestPayloadHash: "a".repeat(64),
  requestPayload: {
    requestId: "audit-test",
    corridorId: "ab".repeat(32),
    payerWallet: "11111111111111111111111111111112",
    recipientWallet:
      "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
    sourceAmount: "500000000",
    destinationAmount: "89550000",
    expiresAt: "2026-10-10T14:00:00.000Z",
  },
  corridorId: "ab".repeat(32),
  payerWallet: "11111111111111111111111111111112",
  recipientWallet:
    "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
  sourceAmount: "500000000",
  destinationAmount: "89550000",
  expiresAt: new Date("2026-10-10T14:00:00.000Z"),
  status: "paid_out",
  version: 8,
  createdAt: new Date("2026-10-10T12:00:00.000Z"),
  updatedAt: new Date("2026-10-10T12:20:00.000Z"),
};

const onrampIntent: OzavOnrampIntent = {
  settlementId,
  customerId: "ozav_cus_private",
  walletId: "ozav_wal_private",
  sourceAmountBrl: "500",
  spreadBps: 0,
  idempotencyKey: "private_idempotency_key",
  quoteId: "ozav_q_onramp",
  quoteTargetAmountUsdt: "89.55",
  paymentInstructions: {
    transferId: "ozav_tr_onramp",
    intentId: "private_pix_intent",
    brCode: "private_pix_br_code",
    qrCodeImage: "data:image/svg+xml,private-qr",
    expiresAt: new Date("2026-10-10T13:00:00.000Z"),
  },
  createdAt: new Date("2026-10-10T12:00:30.000Z"),
  updatedAt: new Date("2026-10-10T12:01:00.000Z"),
};

const onrampBinding: OzavOnrampBinding = {
  settlementId,
  transferId: "ozav_tr_onramp",
  customerId: "ozav_cus_private",
  walletId: "ozav_wal_private",
  quoteId: "ozav_q_onramp",
};

const onrampEvents: OzavStoredEvent[] = [
  {
    eventId: "ozav_evt_onramp_completed",
    settlementId,
    transferId: "ozav_tr_onramp",
    eventType: "transfer.completed",
    occurredAt: completedAt,
    contentHash: "b".repeat(64),
    snapshot: {
      status: "completed",
      sourceLegStatus: "completed",
      destinationLegStatus: "completed",
      sourceAmountBrl: "500",
      targetAmountUsdt: "89.55",
    },
  },
  {
    eventId: "ozav_evt_onramp_started",
    settlementId,
    transferId: "ozav_tr_onramp",
    eventType: "transfer.payment_confirmed",
    occurredAt: firstEventAt,
    contentHash: "c".repeat(64),
    snapshot: {
      status: "payment_confirmed",
      sourceLegStatus: "completed",
      destinationLegStatus: "pending",
      sourceAmountBrl: "500",
      targetAmountUsdt: "89.55",
    },
  },
];

const reserve: SolanaContingencyReserve = {
  settlementId,
  reservePda:
    "D8Dgk77VmuRHUbWnFiGGcVoTBboXjeCogXYC9CyJM6cV",
  vaultPda:
    "7nvFrb4GQs4rrbhDdbNCtgFjFQpwa2mMvvwJT7LmmnUv",
  amountUsdt: "89.55",
  amountBaseUnits: "89550000",
  fallbackAfter: new Date("2026-10-10T12:05:00.000Z"),
  expiresAt: new Date("2026-10-10T14:00:00.000Z"),
  createSignature: "reserve-create-signature",
  settleSignature: null,
  refundSignature: "reserve-refund-signature",
  status: "refunded",
  version: 1,
  createdAt: new Date("2026-10-10T12:00:40.000Z"),
  updatedAt: new Date("2026-10-10T12:04:00.000Z"),
};

const solanaState: SolanaSettlementConfirmationState = {
  settlementId,
  status: "paid_out",
  version: 8,
  settlementPda:
    "G1n2jiEvziMrc1ZrGUh5tpTBp8R56g9v53prGaDfbAsC",
  createSignature: "atomic-signature",
  executeSignature: "atomic-signature",
};

const offrampIntent: OzavOfframpIntent = {
  settlementId,
  customerId: "ozav_cus_private",
  walletId: "ozav_wal_private",
  payoutDestinationId: "ozav_pd_test",
  sourceAmountUsdt: "89.55",
  spreadBps: 0,
  idempotencyKey: "private_offramp_idempotency_key",
  quoteId: "ozav_q_offramp",
  quoteTargetAmountBrl: "500",
  transferId: "ozav_tr_offramp",
  providerStatus: "completed",
  transferSourceAmountUsdt: "89.55",
  transferTargetAmountBrl: "499.98",
  createdAt: new Date("2026-10-10T12:10:00.000Z"),
  updatedAt: new Date("2026-10-10T12:20:00.000Z"),
};

const offrampEvents = [{
  eventId: "ozav_evt_offramp_completed",
  settlementId,
  transferId: "ozav_tr_offramp",
  eventType: "transfer.completed",
  occurredAt: "2026-10-10T12:20:00.000Z",
  contentHash: "d".repeat(64),
  snapshot: {
    status: "completed" as const,
    sourceLegStatus: "completed",
    destinationLegStatus: "completed",
    sourceAmountUsdt: "89.55",
    targetAmountBrl: "499.98",
  },
}];

function options(
  overrides: Partial<GetSettlementAuditOptions> = {},
): GetSettlementAuditOptions {
  return {
    settlements: {
      async findById(id) {
        return id === settlementId ? settlement : null;
      },
    },
    onrampIntents: {
      async find() {
        return onrampIntent;
      },
    },
    onramps: {
      async findBinding() {
        return onrampBinding;
      },
      async listEvents() {
        return onrampEvents;
      },
    },
    contingencyReserves: {
      async find() {
        return reserve;
      },
    },
    solanaSettlements: {
      async findBySettlementId() {
        return solanaState;
      },
    },
    offramps: {
      async find() {
        return offrampIntent;
      },
      async listEvents() {
        return offrampEvents;
      },
    },
    now: () => new Date("2026-10-10T12:30:00.000Z"),
    ...overrides,
  };
}

describe("settlement audit read model", () => {
  it("consolidates complete roundtrip evidence", async () => {
    const result = await new GetSettlementAuditService(
      options(),
    ).execute(settlementId);

    expect(result.checks).toEqual({
      onrampCompleted: true,
      reserveResolved: true,
      solanaTransactionRecorded: true,
      offrampCompleted: true,
      settlementPaidOut: true,
      evidenceComplete: true,
    });
    expect(result.warnings).toEqual([]);
    expect(result.onramp?.events.map((event) => event.eventId))
      .toEqual([
        "ozav_evt_onramp_started",
        "ozav_evt_onramp_completed",
      ]);
    expect(result.contingencyReserve).toMatchObject({
      status: "refunded",
      resolutionAction: "refunded",
      resolutionSignature: "reserve-refund-signature",
    });
    expect(result.solanaSettlement).toMatchObject({
      atomicSignature: "atomic-signature",
      verified: true,
    });
    expect(result.offramp).toMatchObject({
      providerStatus: "completed",
      sourceLegStatus: "completed",
      destinationLegStatus: "completed",
    });
  });

  it("never returns Pix bodies or provider credentials", async () => {
    const result = await new GetSettlementAuditService(
      options(),
    ).execute(settlementId);
    const serialized = JSON.stringify(result);

    for (const secret of [
      "private_pix_br_code",
      "data:image/svg+xml,private-qr",
      "private_pix_intent",
      "ozav_cus_private",
      "ozav_wal_private",
      "private_idempotency_key",
      "private_offramp_idempotency_key",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports a settlement before external evidence exists", async () => {
    const created = {
      ...settlement,
      status: "created" as const,
      version: 0,
    };
    const result = await new GetSettlementAuditService(
      options({
        settlements: {
          async findById() {
            return created;
          },
        },
        onrampIntents: { async find() { return null; } },
        onramps: {
          async findBinding() { return null; },
          async listEvents() { return []; },
        },
        contingencyReserves: {
          async find() { return null; },
        },
        solanaSettlements: {
          async findBySettlementId() {
            return {
              settlementId,
              status: "created",
              version: 0,
              settlementPda: null,
              createSignature: null,
              executeSignature: null,
            };
          },
        },
        offramps: {
          async find() { return null; },
          async listEvents() { return []; },
        },
      }),
    ).execute(settlementId);

    expect(result.onramp).toBeNull();
    expect(result.contingencyReserve).toBeNull();
    expect(result.solanaSettlement).toBeNull();
    expect(result.offramp).toBeNull();
    expect(result.checks.evidenceComplete).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("flags inconsistent identities and Solana signatures", async () => {
    const result = await new GetSettlementAuditService(
      options({
        onramps: {
          async findBinding() {
            return {
              ...onrampBinding,
              transferId: "ozav_tr_different",
            };
          },
          async listEvents() {
            return onrampEvents;
          },
        },
        solanaSettlements: {
          async findBySettlementId() {
            return {
              ...solanaState,
              executeSignature: "different-signature",
            };
          },
        },
      }),
    ).execute(settlementId);

    expect(result.checks.onrampCompleted).toBe(false);
    expect(result.checks.solanaTransactionRecorded)
      .toBe(false);
    expect(result.checks.evidenceComplete).toBe(false);
    expect(result.warnings).toContain(
      "OZAV on-ramp identifiers are inconsistent",
    );
    expect(result.warnings).toContain(
      "Solana settlement evidence is incomplete or inconsistent",
    );
    expect(result.warnings).toContain(
      "Paid-out settlement is missing complete audit evidence",
    );
  });

  it("surfaces a missing settlement", async () => {
    const service = new GetSettlementAuditService(
      options({
        settlements: {
          async findById() {
            return null;
          },
        },
      }),
    );

    await expect(service.execute(settlementId))
      .rejects.toBeInstanceOf(
        SettlementAuditNotFoundError,
      );
  });
});
