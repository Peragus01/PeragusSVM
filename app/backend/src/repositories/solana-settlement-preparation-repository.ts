import type { Pool } from "pg";

export interface SaveSolanaSettlementPreparationInput {
  settlementId: string;
  expectedVersion: number;
  settlementPda: string;
}

export interface SaveSolanaSettlementPreparationResult {
  settlementPda: string;
  saved: boolean;
}

export interface SolanaSettlementPreparationRepository {
  savePrepared(
    input: SaveSolanaSettlementPreparationInput,
  ): Promise<SaveSolanaSettlementPreparationResult>;
}

interface PreparationRow {
  settlement_pda: string | null;
  status: string;
}

export class PostgresSolanaSettlementPreparationRepository
  implements SolanaSettlementPreparationRepository
{
  constructor(private readonly pool: Pool) {}

  async savePrepared(
    input: SaveSolanaSettlementPreparationInput,
  ): Promise<SaveSolanaSettlementPreparationResult> {
    const updated = await this.pool.query<PreparationRow>(
      `
        update settlements
        set settlement_pda = $2
        where id = $1
          and status = 'tokenized'
          and version = $3
          and settlement_pda is null
        returning settlement_pda, status
      `,
      [
        input.settlementId,
        input.settlementPda,
        input.expectedVersion,
      ],
    );

    const updatedRow = updated.rows[0];

    if (updatedRow?.settlement_pda) {
      return {
        settlementPda: updatedRow.settlement_pda,
        saved: true,
      };
    }

    const current = await this.pool.query<PreparationRow>(
      `
        select settlement_pda, status
        from settlements
        where id = $1
        limit 1
      `,
      [input.settlementId],
    );

    const currentRow = current.rows[0];

    if (
      currentRow?.status === "tokenized"
      && currentRow.settlement_pda === input.settlementPda
    ) {
      return {
        settlementPda: currentRow.settlement_pda,
        saved: false,
      };
    }

    throw new Error(
      `Settlement ${input.settlementId} changed while preparing its Solana transaction`,
    );
  }
}
