import type { Pool, QueryResult } from "pg";

import {
  normalizeOzavOnrampIntentRequest,
  normalizeOzavPixPaymentInstructions,
  normalizeOzavQuoteTargetAmount,
  OzavOnrampInitiationError,
  sameOzavOnrampIntentRequest,
  type OzavOnrampIntent,
  type OzavOnrampIntentRequest,
  type OzavPixPaymentInstructions,
} from "../domain/ozav-onramp-intent.js";
import type {
  OzavOnrampIntentRepository,
  SaveOzavPaymentInstructionsInput,
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
  transfer_id: string | null;
  pix_intent_id: string | null;
  pix_br_code: string | null;
  pix_qr_code_image: string | null;
  pix_expires_at: Date | null;
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
  transfer_id,
  pix_intent_id,
  pix_br_code,
  pix_qr_code_image,
  pix_expires_at,
  created_at,
  updated_at
`;

function mapPaymentInstructions(
  row: IntentRow,
): OzavPixPaymentInstructions | null {
  const values = [
    row.transfer_id,
    row.pix_intent_id,
    row.pix_br_code,
    row.pix_qr_code_image,
    row.pix_expires_at,
  ];
  if (values.every((value) => value === null)) {
    return null;
  }
  if (
    row.transfer_id === null
    || row.pix_intent_id === null
    || row.pix_br_code === null
    || row.pix_expires_at === null
  ) {
    throw new OzavOnrampInitiationError(
      "Stored OZAV Pix payment instructions are incomplete",
    );
  }
  return normalizeOzavPixPaymentInstructions({
    transferId: row.transfer_id,
    intentId: row.pix_intent_id,
    brCode: row.pix_br_code,
    qrCodeImage: row.pix_qr_code_image,
    expiresAt: row.pix_expires_at,
  });
}

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
    paymentInstructions: mapPaymentInstructions(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function samePaymentInstructions(
  left: OzavPixPaymentInstructions,
  right: OzavPixPaymentInstructions,
): boolean {
  return left.transferId === right.transferId
    && left.intentId === right.intentId
    && left.brCode === right.brCode
    && left.qrCodeImage === right.qrCodeImage
    && left.expiresAt.getTime() === right.expiresAt.getTime();
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

  async savePaymentInstructions(
    input: SaveOzavPaymentInstructionsInput,
  ): Promise<OzavOnrampIntent> {
    if (Number.isNaN(input.updatedAt.getTime())) {
      throw new OzavOnrampInitiationError(
        "Invalid OZAV payment instruction timestamp",
      );
    }
    const payment = normalizeOzavPixPaymentInstructions(
      input.paymentInstructions,
    );
    let updated: QueryResult<IntentRow>;
    try {
      updated = await this.database.query<IntentRow>(
        `
          update settlement_ozav_onramp_intents
          set
            transfer_id = $2,
            pix_intent_id = $3,
            pix_br_code = $4,
            pix_qr_code_image = $5,
            pix_expires_at = $6,
            updated_at = $7
          where settlement_id = $1
            and transfer_id is null
          returning ${columns}
        `,
        [
          input.settlementId,
          payment.transferId,
          payment.intentId,
          payment.brCode,
          payment.qrCodeImage,
          payment.expiresAt,
          input.updatedAt,
        ],
      );
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new OzavOnrampInitiationError(
          "OZAV transfer payment instructions are already reserved",
        );
      }
      throw error;
    }
    const row = updated.rows[0];
    if (row) return mapIntent(row);
    const existing = await this.find(input.settlementId);
    if (
      !existing?.paymentInstructions
      || !samePaymentInstructions(
        existing.paymentInstructions,
        payment,
      )
    ) {
      throw new OzavOnrampInitiationError(
        "Settlement already has different OZAV payment instructions",
      );
    }
    return existing;
  }
}
