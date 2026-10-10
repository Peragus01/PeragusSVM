import type { Pool } from "pg";

export interface SolanaContingencyReserve {
  settlementId: string;
  reservePda: string;
  vaultPda: string;
  amountUsdt: string;
  amountBaseUnits: string;
  fallbackAfter: Date;
  expiresAt: Date;
  createSignature: string;
  settleSignature: string | null;
  refundSignature: string | null;
  status: "funded" | "settled" | "refunded";
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveFundedContingencyReserveInput {
  settlementId: string;
  reservePda: string;
  vaultPda: string;
  amountUsdt: string;
  amountBaseUnits: string;
  fallbackAfter: Date;
  expiresAt: Date;
  createSignature: string;
}

export interface FinalizeContingencyReserveInput {
  settlementId: string;
  expectedVersion: number;
  signature: string;
}

export interface SolanaContingencyReserveRepository {
  find(
    settlementId: string,
  ): Promise<SolanaContingencyReserve | null>;

  saveFunded(
    input: SaveFundedContingencyReserveInput,
  ): Promise<SolanaContingencyReserve>;

  markSettled(
    input: FinalizeContingencyReserveInput,
  ): Promise<SolanaContingencyReserve>;

  markRefunded(
    input: FinalizeContingencyReserveInput,
  ): Promise<SolanaContingencyReserve>;
}

interface ReserveRow {
  settlement_id: string;
  reserve_pda: string;
  vault_pda: string;
  amount_usdt: string;
  amount_base_units: string;
  fallback_after: Date;
  expires_at: Date;
  create_signature: string;
  settle_signature: string | null;
  refund_signature: string | null;
  status: "funded" | "settled" | "refunded";
  version: number;
  created_at: Date;
  updated_at: Date;
}

const columns = `
  settlement_id,
  reserve_pda,
  vault_pda,
  amount_usdt,
  amount_base_units,
  fallback_after,
  expires_at,
  create_signature,
  settle_signature,
  refund_signature,
  status,
  version,
  created_at,
  updated_at
`;

function mapRow(row: ReserveRow): SolanaContingencyReserve {
  return {
    settlementId: row.settlement_id,
    reservePda: row.reserve_pda,
    vaultPda: row.vault_pda,
    amountUsdt: row.amount_usdt,
    amountBaseUnits: row.amount_base_units,
    fallbackAfter: row.fallback_after,
    expiresAt: row.expires_at,
    createSignature: row.create_signature,
    settleSignature: row.settle_signature,
    refundSignature: row.refund_signature,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresSolanaContingencyReserveRepository
  implements SolanaContingencyReserveRepository
{
  constructor(private readonly pool: Pool) {}

  async find(
    settlementId: string,
  ): Promise<SolanaContingencyReserve | null> {
    const result = await this.pool.query<ReserveRow>(
      `
        select ${columns}
        from settlement_solana_contingency_reserves
        where settlement_id = $1
        limit 1
      `,
      [settlementId],
    );

    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async saveFunded(
    input: SaveFundedContingencyReserveInput,
  ): Promise<SolanaContingencyReserve> {
    const result = await this.pool.query<ReserveRow>(
      `
        insert into settlement_solana_contingency_reserves (
          settlement_id,
          reserve_pda,
          vault_pda,
          amount_usdt,
          amount_base_units,
          fallback_after,
          expires_at,
          create_signature,
          status
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'funded')
        on conflict (settlement_id) do nothing
        returning ${columns}
      `,
      [
        input.settlementId,
        input.reservePda,
        input.vaultPda,
        input.amountUsdt,
        input.amountBaseUnits,
        input.fallbackAfter,
        input.expiresAt,
        input.createSignature,
      ],
    );

    const inserted = result.rows[0];
    if (inserted) {
      return mapRow(inserted);
    }

    const existing = await this.find(input.settlementId);
    if (
      existing
      && existing.reservePda === input.reservePda
      && existing.vaultPda === input.vaultPda
      && existing.amountUsdt === input.amountUsdt
      && existing.amountBaseUnits === input.amountBaseUnits
      && existing.fallbackAfter.getTime()
        === input.fallbackAfter.getTime()
      && existing.expiresAt.getTime() === input.expiresAt.getTime()
    ) {
      return existing;
    }

    throw new Error(
      `Settlement ${input.settlementId} already has a different contingency reserve`,
    );
  }

  private async finalize(
    input: FinalizeContingencyReserveInput,
    status: "settled" | "refunded",
  ): Promise<SolanaContingencyReserve> {
    const signatureColumn = status === "settled"
      ? "settle_signature"
      : "refund_signature";

    const result = await this.pool.query<ReserveRow>(
      `
        update settlement_solana_contingency_reserves
        set
          status = $3,
          ${signatureColumn} = $4,
          version = version + 1
        where settlement_id = $1
          and status = 'funded'
          and version = $2
        returning ${columns}
      `,
      [
        input.settlementId,
        input.expectedVersion,
        status,
        input.signature,
      ],
    );

    const updated = result.rows[0];
    if (updated) {
      return mapRow(updated);
    }

    const existing = await this.find(input.settlementId);
    const recordedSignature = status === "settled"
      ? existing?.settleSignature
      : existing?.refundSignature;

    if (
      existing?.status === status
      && recordedSignature === input.signature
    ) {
      return existing;
    }

    throw new Error(
      `Contingency reserve ${input.settlementId} changed concurrently`,
    );
  }

  async markSettled(
    input: FinalizeContingencyReserveInput,
  ): Promise<SolanaContingencyReserve> {
    return this.finalize(input, "settled");
  }

  async markRefunded(
    input: FinalizeContingencyReserveInput,
  ): Promise<SolanaContingencyReserve> {
    return this.finalize(input, "refunded");
  }
}
