import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresSolanaSettlementConfirmationRepository,
  SolanaSettlementConfirmationPersistenceError,
} from "../src/repositories/solana-settlement-confirmation-repository.js";

const SETTLEMENT_ID =
  "a85c5f14-0114-4f0f-8da3-00d2d3a3b4b5";
const SETTLEMENT_PDA =
  "D8Dgk77VmuRHUbWnFiGGcVoTBboXjeCogXYC9CyJM6cV";
const SIGNATURE = "1".repeat(88);

function row(
  status: "tokenized" | "settling" | "settled",
  version: number,
  signatures: string | null = null,
) {
  return {
    id: SETTLEMENT_ID,
    status,
    version,
    settlement_pda: SETTLEMENT_PDA,
    create_signature: signatures,
    execute_signature: signatures,
  };
}

function createHarness(
  current = row("tokenized", 4),
) {
  const statements: string[] = [];
  const query = vi.fn(
    async (sql: string, parameters?: unknown[]) => {
      const statement = sql.trim();
      statements.push(statement);

      if (
        statement === "begin"
        || statement === "commit"
        || statement === "rollback"
      ) {
        return { rows: [] };
      }

      if (statement.includes("for update")) {
        return { rows: [current] };
      }

      if (statement.includes("set status = 'settled'")) {
        expect(parameters).toEqual([
          SETTLEMENT_ID,
          5,
          SETTLEMENT_PDA,
          SIGNATURE,
        ]);

        return {
          rows: [row("settled", 6, SIGNATURE)],
        };
      }

      if (statement.includes("status = 'settling'")) {
        expect(parameters).toEqual([
          SETTLEMENT_ID,
          4,
          SETTLEMENT_PDA,
          SIGNATURE,
        ]);

        return {
          rows: [row("settling", 5, SIGNATURE)],
        };
      }

      throw new Error(`Unexpected SQL: ${statement}`);
    },
  );
  const release = vi.fn();
  const client = {
    query,
    release,
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  const repository =
    new PostgresSolanaSettlementConfirmationRepository(pool);

  return {
    query,
    release,
    repository,
    statements,
  };
}

describe(
  "PostgresSolanaSettlementConfirmationRepository",
  () => {
    it("persists tokenized -> settling -> settled atomically", async () => {
      const harness = createHarness();

      const result = await harness.repository.confirmSettled({
        settlementId: SETTLEMENT_ID,
        expectedVersion: 4,
        settlementPda: SETTLEMENT_PDA,
        signature: SIGNATURE,
      });

      expect(result).toEqual({
        settlementId: SETTLEMENT_ID,
        status: "settled",
        version: 6,
        settlementPda: SETTLEMENT_PDA,
        createSignature: SIGNATURE,
        executeSignature: SIGNATURE,
        saved: true,
      });
      expect(harness.statements[0]).toBe("begin");
      expect(harness.statements.at(-1)).toBe("commit");
      expect(harness.statements).not.toContain("rollback");
      expect(harness.release).toHaveBeenCalledOnce();
    });

    it("returns an idempotent replay without another update", async () => {
      const harness = createHarness(
        row("settled", 6, SIGNATURE),
      );

      const result = await harness.repository.confirmSettled({
        settlementId: SETTLEMENT_ID,
        expectedVersion: 6,
        settlementPda: SETTLEMENT_PDA,
        signature: SIGNATURE,
      });

      expect(result.saved).toBe(false);
      expect(result.status).toBe("settled");
      expect(harness.statements).toHaveLength(3);
      expect(harness.statements.at(-1)).toBe("commit");
      expect(harness.release).toHaveBeenCalledOnce();
    });

    it("rolls back a conflicting settlement state", async () => {
      const harness = createHarness(row("settling", 5));

      await expect(
        harness.repository.confirmSettled({
          settlementId: SETTLEMENT_ID,
          expectedVersion: 4,
          settlementPda: SETTLEMENT_PDA,
          signature: SIGNATURE,
        }),
      ).rejects.toBeInstanceOf(
        SolanaSettlementConfirmationPersistenceError,
      );

      expect(harness.statements.at(-1)).toBe("rollback");
      expect(harness.statements).not.toContain("commit");
      expect(harness.release).toHaveBeenCalledOnce();
    });
  },
);
