import type { Pool, QueryResult } from "pg";

import {
  normalizeOzavOnrampIntentRequest,
  normalizeOzavQuoteTargetAmount,
  OzavOnrampInitiationError,
  sameOzavOnrampIntentRequest,
  type OzavOnrampIntent,
  type OzavOnrampIntentRequest,
} from "../domain/ozav-onramp-intent.js";
import type {
  OzavOnrampIntentRepository,
  SaveOzavQuoteInput,
} from "./ozav-onramp-intent-repository.js";

interface IntentRow {
  settlement_id: string;
  customer_id: string;
  wallet_id: string;
  source_amount_brl: string;
  spread_bps: number;
  idempotency_key: string;
  quote_id: string | null;
  quote_target_amount_usdt: string | null;
  created_at: Date;
  updated_at: Date;
}

const columns = `
  settlement_id,
  customer_id,
  wallet_id,
  source_amount_brl,
  spread_bps,
  idempotency_key,
  quote_id,
  quote_target_amount_usdt,
  created_at,
  updated_at
`;

function mapIntent(row: IntentRow): OzavOnrampIntent {
  return {
    settlementId: row.settlement_id,
    customerId: row.customer_id,
    walletId: row.wallet_id,
    sourceAmountBrl: row.source_amount_brl,
    spreadBps: row.spread_bps,
    idempotencyKey: row.idempotency_key,
    quoteId: row.quote_id,
    quoteTargetAmountUsdt: row.quote_target_amount_usdt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505";
}

export class PostgresOzavOnrampIntentRepository
  implements OzavOnrampIntentRepository
{
  private readonly database: Pick<Pool, "query">;

  constructor(database: Pick<Pool, "query">) {
    this.database = database;
  }

  async reserve(
    input: OzavOnrampIntentRequest,
  ): Promise<{
    intent: OzavOnrampIntent;
    created: boolean;
  }> {
    const request = normalizeOzavOnrampIntentRequest(input);
    let inserted: QueryResult<IntentRow>;
    try {
      inserted = await this.database.query<IntentRow>(
        `
          insert into settlement_ozav_onramp_intents (
            settlement_id,
            customer_id,
            wallet_id,
            source_amount_brl,
            spread_bps,
            idempotency_key
          )
          values ($1, $2, $3, $4, $5, $6)
          on conflict (settlement_id) do nothing
          returning ${columns}
        `,
        [
          request.settlementId,
          request.customerId,
          request.walletId,
          request.sourceAmountBrl,
          request.spreadBps,
          request.idempotencyKey,
        ],
      );
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new OzavOnrampInitiationError(
          "OZAV idempotency key is already reserved",
        );
      }
      throw error;
    }
    const row = inserted.rows[0];
    if (row) {
      return {
        intent: mapIntent(row),
        created: true,
      };
    }
    const existing = await this.find(request.settlementId);
    if (
      !existing
      || !sameOzavOnrampIntentRequest(existing, request)
    ) {
      throw new OzavOnrampInitiationError(
        "Settlement already has a different OZAV on-ramp intent",
      );
    }
    return {
      intent: existing,
      created: false,
    };
  }

  async find(
    settlementId: string,
  ): Promise<OzavOnrampIntent | null> {
    const result = await this.database.query<IntentRow>(
      `
        select ${columns}
        from settlement_ozav_onramp_intents
        where settlement_id = $1
      `,
      [settlementId],
    );
    const row = result.rows[0];
    return row ? mapIntent(row) : null;
  }

  async saveQuote(
    input: SaveOzavQuoteInput,
  ): Promise<OzavOnrampIntent> {
    if (
      !/^ozav_q_[A-Za-z0-9_]+$/.test(input.quoteId)
      || Number.isNaN(input.updatedAt.getTime())
    ) {
      throw new OzavOnrampInitiationError(
        "Invalid OZAV quote reservation",
      );
    }
    const targetAmount = normalizeOzavQuoteTargetAmount(
      input.quoteTargetAmountUsdt,
    );
    let updated: QueryResult<IntentRow>;
    try {
      updated = await this.database.query<IntentRow>(
        `
          update settlement_ozav_onramp_intents
          set
            quote_id = $2,
            quote_target_amount_usdt = $3,
            updated_at = $4
          where settlement_id = $1
            and quote_id is null
          returning ${columns}
        `,
        [
          input.settlementId,
          input.quoteId,
          targetAmount,
          input.updatedAt,
        ],
      );
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new OzavOnrampInitiationError(
          "OZAV quote is already reserved",
        );
      }
      throw error;
    }
    const row = updated.rows[0];
    if (row) return mapIntent(row);
    const existing = await this.find(input.settlementId);
    if (!existing?.quoteId) {
      throw new OzavOnrampInitiationError(
        "OZAV on-ramp intent was not found",
      );
    }
    return existing;
  }
}
