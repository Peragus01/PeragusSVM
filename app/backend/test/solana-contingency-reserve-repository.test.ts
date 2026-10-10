import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresSolanaContingencyReserveRepository } from "../src/repositories/solana-contingency-reserve-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

function fundedRow() {
  return {
    settlement_id: settlementId,
    reserve_pda:
      "D8Dgk77VmuRHUbWnFiGGcVoTBboXjeCogXYC9CyJM6cV",
    vault_pda:
      "7nvFrb4GQs4rrbhDdbNCtgFjFQpwa2mMvvwJT7LmmnUv",
    amount_usdt: "89.55",
    amount_base_units: "89550000",
    fallback_after: new Date("2026-10-07T12:05:00Z"),
    expires_at: new Date("2026-10-07T13:00:00Z"),
    create_signature: "create-signature",
    settle_signature: null,
    refund_signature: null,
    status: "funded" as const,
    version: 0,
    created_at: new Date("2026-10-07T12:00:00Z"),
    updated_at: new Date("2026-10-07T12:00:01Z"),
  };
}

function setup(
  initial: ReturnType<typeof fundedRow> | Record<string, unknown>
    = fundedRow(),
) {
  let stored: Record<string, unknown> = initial;
  const query = vi.fn(
    async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("update settlement_solana_contingency_reserves")) {
        const expectedVersion = parameters?.[1];
        const nextStatus = parameters?.[2];
        const signature = parameters?.[3];

        if (
          stored.status !== "funded"
          || stored.version !== expectedVersion
        ) {
          return { rows: [], rowCount: 0 };
        }

        stored = {
          ...stored,
          status: nextStatus,
          settle_signature:
            nextStatus === "settled" ? signature : null,
          refund_signature:
            nextStatus === "refunded" ? signature : null,
          version: Number(stored.version) + 1,
          updated_at: new Date("2026-10-07T12:10:00Z"),
        };
        return { rows: [stored], rowCount: 1 };
      }

      if (sql.includes("select")) {
        return { rows: [stored], rowCount: 1 };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  );
  const repository =
    new PostgresSolanaContingencyReserveRepository({
      query,
    } as unknown as Pool);

  return { query, repository };
}

describe("PostgresSolanaContingencyReserveRepository", () => {
  it("atomically records a settled reserve with its signature", async () => {
    const subject = setup();

    const result = await subject.repository.markSettled({
      settlementId,
      expectedVersion: 0,
      signature: "settle-signature",
    });

    expect(result).toMatchObject({
      status: "settled",
      settleSignature: "settle-signature",
      refundSignature: null,
      version: 1,
    });
    expect(subject.query).toHaveBeenCalledOnce();
  });

  it("atomically records a refunded reserve with its signature", async () => {
    const subject = setup();

    const result = await subject.repository.markRefunded({
      settlementId,
      expectedVersion: 0,
      signature: "refund-signature",
    });

    expect(result).toMatchObject({
      status: "refunded",
      settleSignature: null,
      refundSignature: "refund-signature",
      version: 1,
    });
  });

  it("accepts an exact idempotent replay after a concurrent update", async () => {
    const subject = setup({
      ...fundedRow(),
      status: "refunded",
      refund_signature: "refund-signature",
      version: 1,
    });

    const result = await subject.repository.markRefunded({
      settlementId,
      expectedVersion: 0,
      signature: "refund-signature",
    });

    expect(result.status).toBe("refunded");
    expect(result.version).toBe(1);
    expect(subject.query).toHaveBeenCalledTimes(2);
  });

  it("rejects a conflicting reserve finalization", async () => {
    const subject = setup({
      ...fundedRow(),
      status: "settled",
      settle_signature: "settle-signature",
      version: 1,
    });

    await expect(subject.repository.markRefunded({
      settlementId,
      expectedVersion: 0,
      signature: "refund-signature",
    })).rejects.toThrow("changed concurrently");
  });
});
