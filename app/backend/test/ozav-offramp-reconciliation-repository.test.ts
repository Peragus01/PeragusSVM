import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { OzavOfframpIntent } from "../src/domain/ozav-offramp-intent.js";
import type { OzavEvent, OzavTransfer } from "../src/providers/ozav-client.js";
import { PostgresOzavOfframpIntentRepository } from "../src/repositories/postgres-ozav-offramp-intent-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

const intent: OzavOfframpIntent = {
  settlementId,
  customerId: "ozav_cus_test",
  walletId: "ozav_wal_test",
  payoutDestinationId: "ozav_pd_test",
  sourceAmountUsdt: "89.55",
  spreadBps: 0,
  idempotencyKey:
    "peragus_offramp_00000000000040008000000000000001",
  quoteId: "ozav_q_offramp",
  quoteTargetAmountBrl: "500",
  transferId: "ozav_tr_offramp",
  providerStatus: "converting",
  transferSourceAmountUsdt: "89.55",
  transferTargetAmountBrl: "499.98",
  createdAt: new Date("2026-10-10T12:00:00Z"),
  updatedAt: new Date("2026-10-10T12:01:00Z"),
};

const transfer: OzavTransfer = {
  id: "ozav_tr_offramp",
  status: "completed",
  customerId: "ozav_cus_test",
  quoteId: "ozav_q_offramp",
  source: {
    type: "wallet",
    currency: "USDT",
    rail: null,
    walletId: "ozav_wal_test",
  },
  destination: {
    type: "payout_destination",
    walletId: null,
    payoutDestinationId: "ozav_pd_test",
  },
  sourceLegStatus: "completed",
  destinationLegStatus: "completed",
  amounts: {
    source: { amount: "89.55", currency: "USDT" },
    target: { amount: "499.98", currency: "BRL" },
  },
};

const event: OzavEvent = {
  id: "ozav_evt_offramp_completed",
  type: "transfer.completed",
  createdAt: "2026-10-10T12:10:00Z",
  transfer,
};

function rowFromIntent(value: OzavOfframpIntent) {
  return {
    settlement_id: value.settlementId,
    customer_id: value.customerId,
    wallet_id: value.walletId,
    payout_destination_id: value.payoutDestinationId,
    source_amount_usdt: value.sourceAmountUsdt,
    spread_bps: value.spreadBps,
    idempotency_key: value.idempotencyKey,
    quote_id: value.quoteId,
    quote_target_amount_brl: value.quoteTargetAmountBrl,
    transfer_id: value.transferId,
    provider_status: value.providerStatus,
    transfer_source_amount_usdt:
      value.transferSourceAmountUsdt,
    transfer_target_amount_brl:
      value.transferTargetAmountBrl,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function createHarness() {
  let intentRow = rowFromIntent(intent);
  const events = new Map<string, Record<string, unknown>>();
  const processed = new Set<string>();
  const query = vi.fn(
    async (sql: string, parameters?: unknown[]) => {
      if (
        sql.includes("update settlement_ozav_offramp_intents")
      ) {
        if (
          parameters?.[0] !== settlementId
          || parameters?.[1] !== intent.transferId
          || parameters?.[3] !== intent.sourceAmountUsdt
        ) {
          return { rows: [], rowCount: 0 };
        }
        intentRow = {
          ...intentRow,
          provider_status: parameters[2] as string,
          transfer_source_amount_usdt:
            parameters[3] as string,
          transfer_target_amount_brl:
            parameters[4] as string,
          updated_at: parameters[5] as Date,
        };
        return { rows: [intentRow], rowCount: 1 };
      }

      if (
        sql.includes("insert into settlement_ozav_offramp_events")
      ) {
        const eventId = parameters?.[0] as string;
        if (events.has(eventId)) {
          return { rows: [], rowCount: 0 };
        }
        events.set(eventId, {
          event_id: eventId,
          settlement_id: parameters?.[1],
          transfer_id: parameters?.[2],
          event_type: parameters?.[3],
          occurred_at: new Date(parameters?.[4] as string),
          content_hash: parameters?.[5],
          snapshot: parameters?.[6],
        });
        return { rows: [{ event_id: eventId }], rowCount: 1 };
      }

      if (sql.includes("select content_hash")) {
        const stored = events.get(parameters?.[0] as string);
        return {
          rows: stored
            ? [{ content_hash: stored.content_hash }]
            : [],
          rowCount: stored ? 1 : 0,
        };
      }

      if (
        sql.includes("from settlement_ozav_offramp_events")
      ) {
        return {
          rows: [...events.values()],
          rowCount: events.size,
        };
      }

      if (
        sql.includes("update settlement_ozav_offramp_events")
      ) {
        const ids = parameters?.[1] as string[];
        const changed = ids.filter((id) => {
          if (!events.has(id) || processed.has(id)) {
            return false;
          }
          processed.add(id);
          return true;
        });
        return {
          rows: changed.map((eventId) => ({ event_id: eventId })),
          rowCount: changed.length,
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  );
  const repository =
    new PostgresOzavOfframpIntentRepository({
      query,
    } as unknown as Pool);

  return { repository, events, processed };
}

describe("Postgres OZAV off-ramp reconciliation repository", () => {
  it("updates provider state and persists events idempotently", async () => {
    const subject = createHarness();

    await expect(subject.repository.updateTransferState({
      settlementId,
      transferId: "ozav_tr_offramp",
      providerStatus: "completed",
      sourceAmountUsdt: "89.550000",
      targetAmountBrl: "499.980000",
      updatedAt: new Date("2026-10-10T12:11:00Z"),
    })).resolves.toMatchObject({
      providerStatus: "completed",
      transferSourceAmountUsdt: "89.55",
      transferTargetAmountBrl: "499.98",
    });

    expect(await subject.repository.recordEvent(
      intent,
      event,
    )).toEqual({ inserted: true });
    expect(await subject.repository.recordEvent(
      intent,
      event,
    )).toEqual({ inserted: false });

    await expect(subject.repository.listEvents(settlementId))
      .resolves.toMatchObject([{
        eventId: event.id,
        settlementId,
        transferId: transfer.id,
        eventType: "transfer.completed",
      }]);
    await expect(subject.repository.markEventsProcessed(
      settlementId,
      [event.id],
      new Date("2026-10-10T12:12:00Z"),
    )).resolves.toBe(1);
    await expect(subject.repository.markEventsProcessed(
      settlementId,
      [event.id],
      new Date("2026-10-10T12:13:00Z"),
    )).resolves.toBe(0);
  });

  it("rejects a transfer update for a different source amount", async () => {
    const subject = createHarness();

    await expect(subject.repository.updateTransferState({
      settlementId,
      transferId: "ozav_tr_offramp",
      providerStatus: "completed",
      sourceAmountUsdt: "88.55",
      targetAmountBrl: "499.98",
      updatedAt: new Date("2026-10-10T12:11:00Z"),
    })).rejects.toThrow("does not match");
  });

  it("rejects changed content under an existing event id", async () => {
    const subject = createHarness();
    await subject.repository.recordEvent(intent, event);
    const altered = structuredClone(event);
    altered.transfer!.amounts.target.amount = "450";

    await expect(subject.repository.recordEvent(
      intent,
      altered,
    )).rejects.toThrow("event conflict");
  });
});
