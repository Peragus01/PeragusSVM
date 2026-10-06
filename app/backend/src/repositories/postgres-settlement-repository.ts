import type { Pool } from "pg";

import type {
  Settlement,
  SettlementRequestPayload,
  SettlementStatus,
} from "../domain/settlement.js";
import type {
  CreateOrGetSettlementResult,
  SettlementRepository,
} from "./settlement-repository.js";

interface SettlementRow {
  id: string;
  request_id: string;
  request_payload_hash: string;
  request_payload: SettlementRequestPayload | string;
  corridor_id: string;
  payer_wallet: string;
  recipient_wallet: string;
  source_amount: string;
  destination_amount: string;
  expires_at: Date;
  status: SettlementStatus;
  created_at: Date;
  updated_at: Date;
}

const settlementColumns = `
  id,
  request_id,
  request_payload_hash,
  request_payload,
  corridor_id,
  payer_wallet,
  recipient_wallet,
  source_amount,
  destination_amount,
  expires_at,
  status,
  created_at,
  updated_at
`;

function mapSettlementRow(row: SettlementRow): Settlement {
  const requestPayload =
    typeof row.request_payload === "string"
      ? JSON.parse(row.request_payload) as SettlementRequestPayload
      : row.request_payload;

  return {
    id: row.id,
    requestId: row.request_id,
    requestPayloadHash: row.request_payload_hash,
    requestPayload,
    corridorId: row.corridor_id,
    payerWallet: row.payer_wallet,
    recipientWallet: row.recipient_wallet,
    sourceAmount: row.source_amount,
    destinationAmount: row.destination_amount,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresSettlementRepository
  implements SettlementRepository
{
  constructor(private readonly pool: Pool) {}

  async createOrGet(
    settlement: Settlement,
  ): Promise<CreateOrGetSettlementResult> {
    const inserted = await this.pool.query<SettlementRow>(
      `
        insert into settlements (
          id,
          request_id,
          request_payload_hash,
          request_payload,
          corridor_id,
          payer_wallet,
          recipient_wallet,
          source_amount,
          destination_amount,
          expires_at
        )
        values (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10
        )
        on conflict (request_id) do nothing
        returning ${settlementColumns}
      `,
      [
        settlement.id,
        settlement.requestId,
        settlement.requestPayloadHash,
        settlement.requestPayload,
        settlement.corridorId,
        settlement.payerWallet,
        settlement.recipientWallet,
        settlement.sourceAmount,
        settlement.destinationAmount,
        settlement.expiresAt,
      ],
    );

    const insertedRow = inserted.rows[0];

    if (insertedRow) {
      return {
        settlement: mapSettlementRow(insertedRow),
        created: true,
      };
    }

    const existing = await this.pool.query<SettlementRow>(
      `
        select ${settlementColumns}
        from settlements
        where request_id = $1
        limit 1
      `,
      [settlement.requestId],
    );

    const existingRow = existing.rows[0];

    if (!existingRow) {
      throw new Error(
        `Settlement disappeared after request_id conflict: ${settlement.requestId}`,
      );
    }

    return {
      settlement: mapSettlementRow(existingRow),
      created: false,
    };
  }
}
