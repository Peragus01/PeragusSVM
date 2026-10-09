import type { Pool, QueryResult } from "pg";

import {
  normalizeOzavOfframpBrlAmount,
  normalizeOzavOfframpIntentRequest,
  normalizeOzavTransferStatus,
  normalizeOzavUsdtAmount,
  OzavOfframpInitiationError,
  sameOzavOfframpIntentRequest,
  type OzavOfframpIntent,
  type OzavOfframpIntentRequest,
} from "../domain/ozav-offramp-intent.js";
import type {
  OzavOfframpIntentRepository,
  SaveOzavOfframpQuoteInput,
  SaveOzavOfframpTransferInput,
} from "./ozav-offramp-intent-repository.js";

interface IntentRow {
  settlement_id: string;
  customer_id: string;
  wallet_id: string;
  payout_destination_id: string;
  source_amount_usdt: string;
  spread_bps: number;
  idempotency_key: string;
  quote_id: string | null;
  quote_target_amount_brl: string | null;
  transfer_id: string | null;
  provider_status: string | null;
  transfer_source_amount_usdt: string | null;
  transfer_target_amount_brl: string | null;
  created_at: Date;
  updated_at: Date;
}

const columns = `
  settlement_id,
  customer_id,
  wallet_id,
  payout_destination_id,
  source_amount_usdt,
  spread_bps,
  idempotency_key,
  quote_id,
  quote_target_amount_brl,
  transfer_id,
  provider_status,
  transfer_source_amount_usdt,
  transfer_target_amount_brl,
  created_at,
  updated_at
`;

function mapIntent(row: IntentRow): OzavOfframpIntent {
  const providerStatus = row.provider_status === null
    ? null
    : normalizeOzavTransferStatus(row.provider_status);

  return {
    settlementId: row.settlement_id,
    customerId: row.customer_id,
    walletId: row.wallet_id,
    payoutDestinationId: row.payout_destination_id,
    sourceAmountUsdt: normalizeOzavUsdtAmount(
      row.source_amount_usdt,
    ),
    spreadBps: row.spread_bps,
    idempotencyKey: row.idempotency_key,
    quoteId: row.quote_id,
    quoteTargetAmountBrl:
      row.quote_target_amount_brl === null
        ? null
        : normalizeOzavOfframpBrlAmount(
            row.quote_target_amount_brl,
          ),
    transferId: row.transfer_id,
    providerStatus,
    transferSourceAmountUsdt:
      row.transfer_source_amount_usdt === null
        ? null
        : normalizeOzavUsdtAmount(
            row.transfer_source_amount_usdt,
          ),
    transferTargetAmountBrl:
      row.transfer_target_amount_brl === null
        ? null
        : normalizeOzavOfframpBrlAmount(
            row.transfer_target_amount_brl,
          ),
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

function sameSavedTransfer(
  intent: OzavOfframpIntent,
  input: SaveOzavOfframpTransferInput,
): boolean {
  return intent.transferId === input.transferId
    && intent.providerStatus === input.providerStatus
    && intent.transferSourceAmountUsdt
      === normalizeOzavUsdtAmount(input.sourceAmountUsdt)
    && intent.transferTargetAmountBrl
      === normalizeOzavOfframpBrlAmount(
        input.targetAmountBrl,
      );
}

export class PostgresOzavOfframpIntentRepository
  implements OzavOfframpIntentRepository
{
  private readonly database: Pick<Pool, "query">;

  constructor(database: Pick<Pool, "query">) {
    this.database = database;
  }

  async reserve(
    input: OzavOfframpIntentRequest,
  ): Promise<{
    intent: OzavOfframpIntent;
    created: boolean;
  }> {
    const request = normalizeOzavOfframpIntentRequest(input);
    let inserted: QueryResult<IntentRow>;

    try {
      inserted = await this.database.query<IntentRow>(
        `
          insert into settlement_ozav_offramp_intents (
            settlement_id,
            customer_id,
            wallet_id,
            payout_destination_id,
            source_amount_usdt,
            spread_bps,
            idempotency_key
          )
          values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (settlement_id) do nothing
          returning ${columns}
        `,
        [
          request.settlementId,
          request.customerId,
          request.walletId,
          request.payoutDestinationId,
          request.sourceAmountUsdt,
          request.spreadBps,
          request.idempotencyKey,
        ],
      );
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new OzavOfframpInitiationError(
          "OZAV off-ramp idempotency key is already reserved",
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
      || !sameOzavOfframpIntentRequest(existing, request)
    ) {
      throw new OzavOfframpInitiationError(
        "Settlement already has a different OZAV off-ramp intent",
      );
    }

    return {
      intent: existing,
      created: false,
    };
  }

  async find(
    settlementId: string,
  ): Promise<OzavOfframpIntent | null> {
    const result = await this.database.query<IntentRow>(
      `
        select ${columns}
        from settlement_ozav_offramp_intents
        where settlement_id = $1
      `,
      [settlementId],
    );

    const row = result.rows[0];
    return row ? mapIntent(row) : null;
  }

  async saveQuote(
    input: SaveOzavOfframpQuoteInput,
  ): Promise<OzavOfframpIntent> {
    if (
      !/^ozav_q_[A-Za-z0-9_]+$/.test(input.quoteId)
      || Number.isNaN(input.updatedAt.getTime())
    ) {
      throw new OzavOfframpInitiationError(
        "Invalid OZAV off-ramp quote reservation",
      );
    }

    const targetAmount = normalizeOzavOfframpBrlAmount(
      input.quoteTargetAmountBrl,
    );
    let updated: QueryResult<IntentRow>;

    try {
      updated = await this.database.query<IntentRow>(
        `
          update settlement_ozav_offramp_intents
          set
            quote_id = $2,
            quote_target_amount_brl = $3,
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
        throw new OzavOfframpInitiationError(
          "OZAV off-ramp quote is already reserved",
        );
      }
      throw error;
    }

    const row = updated.rows[0];
    if (row) return mapIntent(row);

    const existing = await this.find(input.settlementId);
    if (!existing?.quoteId) {
      throw new OzavOfframpInitiationError(
        "OZAV off-ramp intent was not found",
      );
    }

    return existing;
  }

  async saveTransfer(
    input: SaveOzavOfframpTransferInput,
  ): Promise<OzavOfframpIntent> {
    if (
      !/^ozav_tr_[A-Za-z0-9_]+$/.test(input.transferId)
      || Number.isNaN(input.updatedAt.getTime())
    ) {
      throw new OzavOfframpInitiationError(
        "Invalid OZAV off-ramp transfer reservation",
      );
    }

    const status = normalizeOzavTransferStatus(
      input.providerStatus,
    );
    const sourceAmount = normalizeOzavUsdtAmount(
      input.sourceAmountUsdt,
    );
    const targetAmount = normalizeOzavOfframpBrlAmount(
      input.targetAmountBrl,
    );
    let updated: QueryResult<IntentRow>;

    try {
      updated = await this.database.query<IntentRow>(
        `
          update settlement_ozav_offramp_intents
          set
            transfer_id = $2,
            provider_status = $3,
            transfer_source_amount_usdt = $4,
            transfer_target_amount_brl = $5,
            updated_at = $6
          where settlement_id = $1
            and transfer_id is null
          returning ${columns}
        `,
        [
          input.settlementId,
          input.transferId,
          status,
          sourceAmount,
          targetAmount,
          input.updatedAt,
        ],
      );
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new OzavOfframpInitiationError(
          "OZAV off-ramp transfer is already reserved",
        );
      }
      throw error;
    }

    const row = updated.rows[0];
    if (row) return mapIntent(row);

    const existing = await this.find(input.settlementId);
    if (!existing || !sameSavedTransfer(existing, input)) {
      throw new OzavOfframpInitiationError(
        "Settlement already has a different OZAV off-ramp transfer",
      );
    }

    return existing;
  }
}
