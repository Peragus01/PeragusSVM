import type { Pool, PoolClient } from "pg";

import type { SettlementStatus } from "../domain/settlement.js";

export interface SolanaSettlementConfirmationState {
  settlementId: string;
  status: SettlementStatus;
  version: number;
  settlementPda: string | null;
  createSignature: string | null;
  executeSignature: string | null;
}

export interface ConfirmSolanaSettlementInput {
  settlementId: string;
  expectedVersion: number;
  settlementPda: string;
  signature: string;
}

export interface ConfirmSolanaSettlementResult
  extends SolanaSettlementConfirmationState {
  saved: boolean;
}

export interface SolanaSettlementConfirmationRepository {
  findBySettlementId(
    settlementId: string,
  ): Promise<SolanaSettlementConfirmationState | null>;

  confirmSettled(
    input: ConfirmSolanaSettlementInput,
  ): Promise<ConfirmSolanaSettlementResult>;
}

export class SolanaSettlementConfirmationPersistenceError
  extends Error
{
  constructor(public readonly settlementId: string) {
    super(
      `Settlement ${settlementId} changed while confirming its Solana transaction`,
    );
    this.name =
      "SolanaSettlementConfirmationPersistenceError";
  }
}

interface ConfirmationRow {
  id: string;
  status: SettlementStatus;
  version: number;
  settlement_pda: string | null;
  create_signature: string | null;
  execute_signature: string | null;
}

const confirmationColumns = `
  id,
  status,
  version,
  settlement_pda,
  create_signature,
  execute_signature
`;

function mapState(
  row: ConfirmationRow,
): SolanaSettlementConfirmationState {
  return {
    settlementId: row.id,
    status: row.status,
    version: row.version,
    settlementPda: row.settlement_pda,
    createSignature: row.create_signature,
    executeSignature: row.execute_signature,
  };
}

async function findWithClient(
  client: PoolClient,
  settlementId: string,
  lock: boolean,
): Promise<ConfirmationRow | null> {
  const result = await client.query<ConfirmationRow>(
    `
      select ${confirmationColumns}
      from settlements
      where id = $1
      limit 1
      ${lock ? "for update" : ""}
    `,
    [settlementId],
  );

  return result.rows[0] ?? null;
}

export class PostgresSolanaSettlementConfirmationRepository
  implements SolanaSettlementConfirmationRepository
{
  constructor(private readonly pool: Pool) {}

  async findBySettlementId(
    settlementId: string,
  ): Promise<SolanaSettlementConfirmationState | null> {
    const result = await this.pool.query<ConfirmationRow>(
      `
        select ${confirmationColumns}
        from settlements
        where id = $1
        limit 1
      `,
      [settlementId],
    );
    const row = result.rows[0];

    return row ? mapState(row) : null;
  }

  async confirmSettled(
    input: ConfirmSolanaSettlementInput,
  ): Promise<ConfirmSolanaSettlementResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      const current = await findWithClient(
        client,
        input.settlementId,
        true,
      );

      if (
        current?.status === "settled"
        && current.settlement_pda === input.settlementPda
        && current.create_signature === input.signature
        && current.execute_signature === input.signature
      ) {
        await client.query("commit");

        return {
          ...mapState(current),
          saved: false,
        };
      }

      if (
        !current
        || current.status !== "tokenized"
        || current.version !== input.expectedVersion
        || current.settlement_pda !== input.settlementPda
        || current.create_signature !== null
        || current.execute_signature !== null
      ) {
        throw new SolanaSettlementConfirmationPersistenceError(
          input.settlementId,
        );
      }

      const settling = await client.query<ConfirmationRow>(
        `
          update settlements
          set
            status = 'settling',
            create_signature = $4,
            execute_signature = $4
          where id = $1
            and status = 'tokenized'
            and version = $2
            and settlement_pda = $3
            and create_signature is null
            and execute_signature is null
          returning ${confirmationColumns}
        `,
        [
          input.settlementId,
          input.expectedVersion,
          input.settlementPda,
          input.signature,
        ],
      );
      const settlingRow = settling.rows[0];

      if (!settlingRow) {
        throw new SolanaSettlementConfirmationPersistenceError(
          input.settlementId,
        );
      }

      const settled = await client.query<ConfirmationRow>(
        `
          update settlements
          set status = 'settled'
          where id = $1
            and status = 'settling'
            and version = $2
            and settlement_pda = $3
            and create_signature = $4
            and execute_signature = $4
          returning ${confirmationColumns}
        `,
        [
          input.settlementId,
          settlingRow.version,
          input.settlementPda,
          input.signature,
        ],
      );
      const settledRow = settled.rows[0];

      if (!settledRow) {
        throw new SolanaSettlementConfirmationPersistenceError(
          input.settlementId,
        );
      }

      await client.query("commit");

      return {
        ...mapState(settledRow),
        saved: true,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
