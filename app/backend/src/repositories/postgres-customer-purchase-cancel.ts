import type {Pool, PoolClient} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment, type RowEnvironment} from "./row-environment.js";
import {transitionOperationInTransaction} from "./postgres-customer-purchase-intents.js";
import {CUSTOMER_CANCELLED, CUSTOMER_CANCEL_REQUESTED, type CancelOutcome, type PurchaseCancelRepository,
  type PurchaseCancelState} from "../purchases/customer-purchase-cancel.js";
import type {OperationStatus} from "../purchases/operation-status.js";

interface Row {id: string; status: OperationStatus; cancel_requested_at: Date | string | null; cancel_request_id: string | null; cancel_withdrawn_at: Date | string | null;
  pix_id: string | null; pix_attempted: boolean | null; pix_paid: boolean | null}
// The stored GET observation shows the Pix payment received.
export const PIX_PAID_SQL = `(x.observation->>'sourceLegStatus'='completed'
 or x.observation->>'status' in ('payment_confirmed','converting','payout_initiated','completed'))`;
const map = (r: Row): PurchaseCancelState => ({purchaseId: r.id, status: r.status,
  cancelRequestedAt: r.cancel_requested_at === null ? null : new Date(r.cancel_requested_at).toISOString(),
  cancelRequestId: r.cancel_request_id, cancelWithdrawn: r.cancel_withdrawn_at !== null,
  pix: r.pix_id ? {id: r.pix_id, attempted: Boolean(r.pix_attempted), paid: Boolean(r.pix_paid)} : null});

export class PostgresPurchaseCancelRepository implements PurchaseCancelRepository {
  private readonly e: RowEnvironment;
  constructor(private readonly pool: Pool, mode: MoneyMode) { this.e = rowEnvironment(mode); }

  private select() {
    return `select p.id,p.status,p.cancel_requested_at,p.cancel_request_id,p.cancel_withdrawn_at,
      x.id as pix_id,x.create_attempted as pix_attempted,coalesce(${PIX_PAID_SQL},false) as pix_paid
     from peragus_customer_purchase_intents p
     left join peragus_customer_sandbox_pix x on x.purchase_intent_id=p.id and x.customer_id=p.customer_id and x.environment=p.environment
     where p.customer_id=$1 and p.id=$2 and p.environment='${this.e.mode}'`;
  }
  async read(customerId: string, purchaseId: string) {
    const r = await this.pool.query<Row>(this.select(), [customerId, purchaseId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async requestUsedElsewhere(customerId: string, purchaseId: string, requestId: string) {
    const r = await this.pool.query("select id from peragus_customer_purchase_intents where customer_id=$1 and cancel_request_id=$2 and id<>$3",
      [customerId, requestId, purchaseId]);
    return Boolean(r.rows[0]);
  }
  private async locked(customerId: string, purchaseId: string,
    work: (client: PoolClient, state: PurchaseCancelState) => Promise<boolean>): Promise<CancelOutcome> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("begin isolation level read committed");
      // Locks the purchase row first; the Pix row is read afterwards (a new statement), so a
      // Pix claim committed while waiting for the lock is always seen.
      // The same purchase row lock every status transition and the Pix claim take.
      const lock = await client.query(`select id from peragus_customer_purchase_intents
        where customer_id=$1 and id=$2 and environment='${this.e.mode}' for update`, [customerId, purchaseId]);
      if (!lock.rows[0]) throw new Error("PURCHASE_CANCEL_NOT_FOUND");
      const state = map((await client.query<Row>(this.select(), [customerId, purchaseId])).rows[0]!);
      const recorded = await work(client, state);
      const after = recorded ? map((await client.query<Row>(this.select(), [customerId, purchaseId])).rows[0]!) : state;
      await client.query(recorded ? "commit" : "rollback");
      return {kind: recorded ? "recorded" : "refused", state: after};
    } catch (error) {
      try { await client.query("rollback"); } catch (rollbackError) { broken = rollbackError instanceof Error ? rollbackError : new Error("ROLLBACK_FAILED"); }
      throw error;
    } finally { client.release(broken); }
  }
  private async mark(client: Pick<PoolClient, "query">, purchaseId: string, requestId: string) {
    await client.query(`update peragus_customer_purchase_intents set cancel_requested_at=now(),cancel_request_id=$2
      where id=$1 and environment='${this.e.mode}' and cancel_requested_at is null`, [purchaseId, requestId]);
  }
  cancelUnfunded(customerId: string, purchaseId: string, requestId: string, actor: string) {
    return this.locked(customerId, purchaseId, async (client, s) => {
      if (s.status !== "accepted" || s.cancelRequestedAt || s.pix?.attempted) return false;
      await this.mark(client, purchaseId, requestId);
      await transitionOperationInTransaction(client, this.e.mode, purchaseId, "expired", actor, CUSTOMER_CANCELLED, {from: "accepted"});
      return true;
    });
  }
  recordRequest(customerId: string, purchaseId: string, requestId: string, actor: string) {
    return this.locked(customerId, purchaseId, async (client, s) => {
      if ((s.status !== "accepted" && s.status !== "awaiting_pix") || s.cancelRequestedAt || s.pix?.paid) return false;
      await this.mark(client, purchaseId, requestId);
      // A note event: the status does not change (from_status = to_status).
      await client.query(`insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
        values($1,$2,$3,$3,$4,$5,'${this.e.mode}')`, [purchaseId, customerId, s.status, actor, CUSTOMER_CANCEL_REQUESTED]);
      return true;
    });
  }
}
