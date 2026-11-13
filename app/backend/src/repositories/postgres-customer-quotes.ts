import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import {inControlledTransaction} from "../operations/runtime-controls.js";
import type { OzavIndicativeQuote } from "../providers/ozav-client.js";
import {
  normalizeQuoteUsdt,
  CustomerQuoteError,
  type CustomerQuoteRepository,
  type CustomerQuoteRecord,
} from "../quotes/customer-quotes.js";
interface Row {
  id: string;
  customer_id: string;
  request_id: string;
  provider_customer_id: string;
  source_amount_brl: string;
  target_amount_usdt?: string | null;
  create_attempted: boolean;
  facility_terms_version?: string | null;
  locked_usdt_amount?: string | null;
  observation: OzavIndicativeQuote | null;
  created_at: Date | string;
}
const map = (r: Row): CustomerQuoteRecord => ({
  id: r.id,
  customerId: r.customer_id,
  requestId: r.request_id,
  providerCustomerId: r.provider_customer_id,
  amountBrl: r.source_amount_brl,
  targetAmountUsdt: r.target_amount_usdt ?? null,
  attempted: r.create_attempted,
  facilityTermsVersion: r.facility_terms_version ?? null,
  lockedUsdtAmount: r.locked_usdt_amount ?? "0.000000",
  quote: r.observation,
  createdAt: new Date(r.created_at).toISOString(),
});
export class PostgresCustomerQuoteRepository implements CustomerQuoteRepository {
  private readonly e: RowEnvironment;
  constructor(
    private readonly pool: Pool,
    mode: MoneyMode,
  ) {
    this.e = rowEnvironment(mode);
  }
  async findRequest(customerId: string, requestId: string) {
    const r = await this.pool.query<Row>(
      `select * from peragus_customer_indicative_quotes where customer_id=$1 and request_id=$2 and environment='${this.e.mode}'`,
      [customerId, requestId],
    );
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async findOwned(customerId: string, id: string) {
    const r = await this.pool.query<Row>(
      `select * from peragus_customer_indicative_quotes where customer_id=$1 and id=$2 and environment='${this.e.mode}'`,
      [customerId, id],
    );
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async reserve(
    customerId: string,
    requestId: string,
    providerCustomerId: string,
    amountBrl: string,
  ) {
    await this.pool.query(
      "insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,environment) values($1,$2,$3,$4,$5,$6) on conflict(customer_id,request_id) do nothing",
      [randomUUID(), customerId, requestId, providerCustomerId, amountBrl, this.e.mode],
    );
    const row = await this.findRequest(customerId, requestId);
    if (
      !row ||
      row.providerCustomerId !== providerCustomerId ||
      row.amountBrl !== amountBrl
    )
      throw new CustomerQuoteError("QUOTE_IDEMPOTENCY_CONFLICT");
    return row;
  }
  async reserveTarget(
    customerId: string,
    requestId: string,
    providerCustomerId: string,
    targetAmount: string,
  ) {
    await this.pool.query(
      "insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,target_amount_usdt,environment) values($1,$2,$3,$4,0,$5,$6) on conflict(customer_id,request_id) do nothing",
      [randomUUID(), customerId, requestId, providerCustomerId, targetAmount, this.e.mode],
    );
    const row = await this.findRequest(customerId, requestId);
    if (
      !row ||
      row.providerCustomerId !== providerCustomerId ||
      row.targetAmountUsdt !== targetAmount
    )
      throw new CustomerQuoteError("QUOTE_IDEMPOTENCY_CONFLICT");
    return row;
  }
  async claim(id: string) {
    // Kill switch new_operations, read `for share` in the claim's own transaction (before the quote POST).
    const r = await inControlledTransaction(this.pool, "new_operations", (client) =>
      client.query(
        `update peragus_customer_indicative_quotes set create_attempted=true,updated_at=now() where id=$1 and environment='${this.e.mode}' and not create_attempted returning id`,
        [id],
      ),
    );
    return Boolean(r.rows[0]);
  }
  async save(row: CustomerQuoteRecord, quote: OzavIndicativeQuote) {
    if (
      quote.customerId !== row.providerCustomerId ||
      (row.targetAmountUsdt
        ? normalizeQuoteUsdt(quote.target.amount) !== row.targetAmountUsdt
        : quote.source.amount !== row.amountBrl) ||
      quote.source.currency !== "BRL" ||
      quote.target.currency !== "USDT" ||
      quote.rateType !== "floating" ||
      quote.expiresAt !== null ||
      quote.spreadBps !== 0
    )
      throw new CustomerQuoteError("QUOTE_CONFLICT", row.id);
    // Defence in depth: a live quote is only stored with its FX rate lock terms.
    if (
      this.e.mode === "live" &&
      !/^[A-Za-z0-9._-]{1,64}$/.test(quote.facility?.termsVersion ?? "")
    )
      throw new CustomerQuoteError("QUOTE_RATE_LOCK_UNAVAILABLE");
    try {
      const r = await this.pool.query<Row>(
        `update peragus_customer_indicative_quotes set provider_quote_id=$3,observation=$4::jsonb,source_amount_brl=$6::numeric,facility_terms_version=$7,locked_usdt_amount=$8::numeric,updated_at=now()
        where id=$1 and customer_id=$2 and provider_customer_id=$5 and environment='${this.e.mode}' and create_attempted and provider_quote_id is null returning *`,
        [
          row.id,
          row.customerId,
          quote.id,
          JSON.stringify(quote),
          row.providerCustomerId,
          quote.source.amount,
          quote.facility?.termsVersion ?? null,
          // The locked amount is the quote's target USDT; the terms version marks a live rate lock.
          quote.target.amount,
        ],
      );
      if (!r.rows[0]) throw new CustomerQuoteError("QUOTE_CONFLICT", row.id);
      return map(r.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new CustomerQuoteError("QUOTE_CONFLICT", row.id);
      throw error;
    }
  }
}
