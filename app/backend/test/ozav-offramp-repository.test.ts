import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { OzavOfframpInitiationError } from "../src/domain/ozav-offramp-intent.js";
import { PostgresOzavOfframpIntentRepository } from "../src/repositories/postgres-ozav-offramp-intent-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

function createHarness() {
  let stored: Record<string, unknown> | null = null;
  const query = vi.fn(
    async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("insert into")) {
        if (stored) return { rows: [], rowCount: 0 };

        stored = {
          settlement_id: parameters?.[0],
          customer_id: parameters?.[1],
          wallet_id: parameters?.[2],
          payout_destination_id: parameters?.[3],
          source_amount_usdt: parameters?.[4],
          spread_bps: parameters?.[5],
          idempotency_key: parameters?.[6],
          quote_id: null,
          quote_target_amount_brl: null,
          transfer_id: null,
          provider_status: null,
          transfer_source_amount_usdt: null,
          transfer_target_amount_brl: null,
          created_at: new Date("2026-10-08T12:00:00Z"),
          updated_at: new Date("2026-10-08T12:00:00Z"),
        };
        return { rows: [stored], rowCount: 1 };
      }

      if (sql.includes("quote_id = $2")) {
        if (!stored || stored.quote_id !== null) {
          return { rows: [], rowCount: 0 };
        }
        stored = {
          ...stored,
          quote_id: parameters?.[1],
          quote_target_amount_brl: parameters?.[2],
          updated_at: parameters?.[3],
        };
        return { rows: [stored], rowCount: 1 };
      }

      if (sql.includes("transfer_id = $2")) {
        if (!stored || stored.transfer_id !== null) {
          return { rows: [], rowCount: 0 };
        }
        stored = {
          ...stored,
          transfer_id: parameters?.[1],
          provider_status: parameters?.[2],
          transfer_source_amount_usdt: parameters?.[3],
          transfer_target_amount_brl: parameters?.[4],
          updated_at: parameters?.[5],
        };
        return { rows: [stored], rowCount: 1 };
      }

      if (sql.includes("select")) {
        return {
          rows: stored ? [stored] : [],
          rowCount: stored ? 1 : 0,
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  );
  const repository =
    new PostgresOzavOfframpIntentRepository({
      query,
    } as unknown as Pool);

  return {
    query,
    repository,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    settlementId,
    customerId: "ozav_cus_test",
    walletId: "ozav_wal_test",
    payoutDestinationId: "ozav_pd_test",
    sourceAmountUsdt: "89.550000",
    spreadBps: 0,
    idempotencyKey:
      "peragus_offramp_00000000000040008000000000000001",
    ...overrides,
  };
}

describe("PostgresOzavOfframpIntentRepository", () => {
  it("persists the idempotent quote and transfer checkpoints", async () => {
    const subject = createHarness();

    const reserved = await subject.repository.reserve(
      request(),
    );
    const quoted = await subject.repository.saveQuote({
      settlementId,
      quoteId: "ozav_q_offramp",
      quoteTargetAmountBrl: "500.00",
      updatedAt: new Date("2026-10-08T12:01:00Z"),
    });
    const transferred =
      await subject.repository.saveTransfer({
        settlementId,
        transferId: "ozav_tr_offramp",
        providerStatus: "converting",
        sourceAmountUsdt: "89.55",
        targetAmountBrl: "499.98",
        updatedAt: new Date("2026-10-08T12:02:00Z"),
      });

    expect(reserved.created).toBe(true);
    expect(reserved.intent.sourceAmountUsdt).toBe("89.55");
    expect(quoted).toMatchObject({
      quoteId: "ozav_q_offramp",
      quoteTargetAmountBrl: "500",
    });
    expect(transferred).toMatchObject({
      transferId: "ozav_tr_offramp",
      providerStatus: "converting",
      transferSourceAmountUsdt: "89.55",
      transferTargetAmountBrl: "499.98",
    });
  });

  it("returns the same reservation on replay", async () => {
    const subject = createHarness();
    await subject.repository.reserve(request());

    const replay = await subject.repository.reserve(request());

    expect(replay.created).toBe(false);
    expect(replay.intent.payoutDestinationId)
      .toBe("ozav_pd_test");
  });

  it("rejects a replay that changes the beneficiary", async () => {
    const subject = createHarness();
    await subject.repository.reserve(request());

    await expect(subject.repository.reserve(request({
      payoutDestinationId: "ozav_pd_other",
    }))).rejects.toBeInstanceOf(
      OzavOfframpInitiationError,
    );
  });
});
