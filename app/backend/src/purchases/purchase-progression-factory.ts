import type {Pool} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import type {OzavClient} from "../providers/ozav-client.js";
import {ManualRefundService} from "../refunds/manual-refunds.js";
import {PostgresCustomerPurchaseIntentRepository} from "../repositories/postgres-customer-purchase-intents.js";
import {PostgresCustomerPixRepository} from "../repositories/postgres-customer-sandbox-pix.js";
import {PostgresCustomerWithdrawalRequestRepository} from "../repositories/postgres-customer-withdrawal-requests.js";
import {purchaseLimits} from "./operation-status.js";
import {PurchaseProgression} from "./purchase-progression.js";

/** Wires the progression for one money mode; the provider must expose GET reads only. */
export function createPurchaseProgression(pool: Pool, mode: MoneyMode,
  env: {PURCHASE_MAX_OPEN_GLOBAL: number; PURCHASE_MIN_BRL: string; PURCHASE_MAX_BRL: string; WITHDRAWAL_OPERATOR_USER_IDS: string[]},
  provider: Pick<OzavClient, "findCustomerPixTransfer" | "getTransfer">): PurchaseProgression {
  const operations = new PostgresCustomerPurchaseIntentRepository(pool, mode, {maxOpenGlobal: env.PURCHASE_MAX_OPEN_GLOBAL, limits: purchaseLimits(env)});
  const reads = Object.freeze({findCustomerPixTransfer: provider.findCustomerPixTransfer.bind(provider), getTransfer: provider.getTransfer.bind(provider)});
  return new PurchaseProgression({pool, mode, operations,
    withdrawals: new PostgresCustomerWithdrawalRequestRepository(pool, mode),
    // System-created refund requests are local records; operator writes stay gated by MANUAL_REFUNDS_ENABLED on the route service.
    refunds: new ManualRefundService(pool, new Set(env.WITHDRAWAL_OPERATOR_USER_IDS), true, mode, true),
    pix: {repo: new PostgresCustomerPixRepository(pool, mode), provider: reads}});
}
