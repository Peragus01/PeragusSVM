import type {Pool} from "pg";
import {SYSTEM_REFUND_REASON,systemRequestId} from "./system-request-id.js";
import type {MoneyMode} from "../config/money-environment.js";
import type {OzavClient} from "../providers/ozav-client.js";
import {usdtMicroUnits} from "../quotes/customer-quotes.js";
import {ManualRefundError,type ManualRefundService} from "../refunds/manual-refunds.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {WithdrawalRequestError,type WithdrawalRequestRepository} from "../withdrawals/customer-withdrawal-requests.js";
import type {PurchaseIntentRepository} from "./customer-purchase-intents.js";
import {pixView,reconcileCustomerPix,type CustomerPixRepository} from "./customer-sandbox-pix.js";
import {TERMINAL_STATUSES,type OperationStatus} from "./operation-status.js";
import {CUSTOMER_CANCEL_REQUESTED,CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT} from "./customer-purchase-cancel.js";

/** OZAV TransferStatus (awaiting_approval is documented as never returned). */
export type OzavTransferStatus = "awaiting_payment" | "payment_confirmed" | "converting" | "payout_initiated"
  | "completed" | "failed" | "cancelled" | "expired" | "needs_review";
export interface TransferObservation {
  /** From GET /v2/transfers/{id}; never from a webhook body. */
  status: OzavTransferStatus | string;
  amountUsdt: string | null;
  /** Source (Pix) leg status; "completed" means the customer's payment was received. */
  sourceLegStatus?: string | null;
}
type ProgressionActor = "system:reconciliation" | "system:webhook";
type PixProvider = Pick<OzavClient, "findCustomerPixTransfer" | "getTransfer">;
export interface PurchaseProgressionDeps {
  pool: Pick<Pool, "query">;
  mode: MoneyMode;
  operations: Pick<PurchaseIntentRepository, "transitionOperation">;
  withdrawals: Pick<WithdrawalRequestRepository, "record">;
  refunds: Pick<ManualRefundService, "request">;
  /** GET-only Pix access, for refreshPix/refreshTransfer. */
  pix?: {repo: Pick<CustomerPixRepository, "read" | "bind" | "save">; provider: PixProvider};
  /** A live create younger than this may still be finishing; an accepted operation is left alone. */
  ambiguousGraceMs?: number;
  /**
   * Final review I9: an unpaid GET expires awaiting_pix only this long after min(Pix expiry,
   * lock deadline) (PIX_EXPIRY_GRACE_MINUTES; the customer stopped seeing instructions earlier).
   */
  expiryGraceMs?: number;
  /**
   * Final review I3: a claimed Pix create for which OZAV lists no transfer (list by metadata)
   * this long after the claim expires the accepted operation (never when a transfer exists).
   */
  createNotFoundGraceMs?: number;
  /** Customer-facing instruction margin (PIX_INSTRUCTIONS_HIDE_MARGIN_MINUTES) for the views returned. */
  instructionsMarginMs?: number;
}
/** Defaults used when the deps do not configure them (env defaults are wired by the factories). */
export const DEFAULT_CREATE_NOT_FOUND_GRACE_MS = 30 * 60_000;

export {systemRequestId};
const REFUND_REASON = SYSTEM_REFUND_REASON;
// OZAV terminal endings. Its needs_review is deliberately absent: it is not terminal.
const CLOSED = new Set(["failed", "cancelled", "expired"]);
/** The only needs_review reason progression may resume from (OZAV may still finish the transfer). */
export const OZAV_REVIEW = "OZAV_TRANSFER_NEEDS_REVIEW";
const PAID_PROGRESS = new Set(["payment_confirmed", "converting", "payout_initiated"]);
// Funding stages this module moves forward; anything later belongs to the operator/send path.
const RANK: Partial<Record<OperationStatus, number>> = {accepted: 0, awaiting_pix: 1, pix_confirmed: 2, converted: 3, awaiting_approval: 4};
interface Context {
  status: OperationStatus; customer_id: string; locked_usdt_amount: string | null;
  pix_id: string | null; pix_created_at: Date | string | null; lock_deadline_at: Date | string | null; pix_expires_at: string | null;
  cancel_requested_at: Date | string | null; cancel_withdrawn_at: Date | string | null;
}
// After a payment the operation proceeded (it is neither still funding nor closed).
const NOT_PROCEEDED: ReadonlySet<OperationStatus> = new Set(["accepted", "awaiting_pix", "expired", "failed", "refund_pending", "refunded"]);

/**
 * Moves a purchase operation forward from the OZAV transfer state read by GET.
 * Never posts to OZAV. Every move goes through transitionOperation (validated
 * again by the database trigger); repeated observations are no-ops.
 */
export class PurchaseProgression {
  private readonly e: RowEnvironment;
  constructor(private readonly deps: PurchaseProgressionDeps) { this.e = rowEnvironment(deps.mode); }

  private async context(purchaseId: string) {
    const r = await this.deps.pool.query<Context>(`select p.status,p.customer_id,p.locked_usdt_amount::text as locked_usdt_amount,
      x.id as pix_id,x.created_at as pix_created_at,x.lock_deadline_at,p.cancel_requested_at,p.cancel_withdrawn_at,
      x.observation->'source'->'paymentInstructions'->>'expiresAt' as pix_expires_at
     from peragus_customer_purchase_intents p
     left join peragus_customer_sandbox_pix x on x.purchase_intent_id=p.id and x.customer_id=p.customer_id and x.environment=p.environment
     where p.id=$1 and p.environment='${this.e.mode}'`, [purchaseId]);
    return r.rows[0] ?? null;
  }

  /**
   * Maps the observed OZAV transfer onto the operation (see the report's table):
   * awaiting_payment -> awaiting_pix (expired after min(Pix expiry, lock deadline)),
   * payment_confirmed|converting|payout_initiated -> pix_confirmed,
   * completed -> converted -> awaiting_approval (+ one system withdrawal request),
   * failed|cancelled|expired -> refund_pending when paid (+ one manual refund request),
   * otherwise failed|expired; needs_review (non-terminal at OZAV) -> needs_review with
   * reason OZAV_TRANSFER_NEEDS_REVIEW, the only review progression resumes from.
   * Returns the resulting status.
   */
  async applyTransferObservation(purchaseId: string, observed: TransferObservation,
    actor: ProgressionActor = "system:reconciliation"): Promise<OperationStatus> {
    const ctx = await this.context(purchaseId);
    if (!ctx) throw new Error("PURCHASE_INTENT_NOT_FOUND");
    const status = await this.progress(purchaseId, ctx, observed, actor);
    // Partner rule (policy 7.1): a payment confirmed by GET while a customer cancel request is
    // open, and before the operation closed, withdraws the request. Recorded once, as a note
    // event (from_status = to_status) that never counts as the last transition.
    const paidObserved = observed.sourceLegStatus === "completed" || PAID_PROGRESS.has(observed.status) || observed.status === "completed";
    if (paidObserved && ctx.cancel_requested_at && !ctx.cancel_withdrawn_at && !NOT_PROCEEDED.has(status)) {
      await this.deps.pool.query(`with u as (update peragus_customer_purchase_intents set cancel_withdrawn_at=now()
         where id=$1 and environment='${this.e.mode}' and cancel_requested_at is not null and cancel_withdrawn_at is null
         returning id,customer_id,status)
        insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
        select id,customer_id,status,status,$2,$3,'${this.e.mode}' from u`, [purchaseId, actor, CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT]);
    }
    return status;
  }

  private async progress(purchaseId: string, ctx: Context, observed: TransferObservation,
    actor: ProgressionActor): Promise<OperationStatus> {
    let status = ctx.status;
    let rank = RANK[status];
    // Every move states the status it was decided from (checked under the row lock, so a
    // stale concurrent decision fails with OPERATION_INVALID_TRANSITION); the first move out
    // of a resumed review also re-checks, in the same locked transaction, that the review
    // is still OZAV's.
    let resumeGuard = false;
    const move = async (to: OperationStatus, reason: string) => {
      const expected = {from: status, ...(resumeGuard ? {lastReason: OZAV_REVIEW} : {})};
      resumeGuard = false;
      await this.deps.operations.transitionOperation(purchaseId, to, actor, reason, expected);
      status = to;
      rank = RANK[to] ?? rank;
    };
    if (status === "refund_pending") return this.ensureRefund(purchaseId, ctx, actor);
    const s = observed.status;
    let paid: boolean;
    if (status === "needs_review") {
      // Resume ONLY a review that OZAV itself caused (its needs_review is non-terminal);
      // every other review reason (lock unknown, amount below lock, ...) is the operator's.
      const last = await this.deps.pool.query<{from_status: OperationStatus | null; reason: string}>(
        // Note events (from_status = to_status, e.g. a customer cancel request) are not transitions.
        "select from_status,reason from peragus_operation_status_events where purchase_id=$1 and from_status is distinct from to_status order by id desc limit 1", [purchaseId]);
      const event = last.rows[0];
      if (event?.reason !== OZAV_REVIEW || s === "needs_review") {
        // An unpaid review entered before any payment (e.g. PIX_LOCK_OUTCOME_UNKNOWN) closes as
        // failed once OZAV reports the transfer terminal and unpaid (Ruling 39).
        const entered = event?.from_status ? RANK[event.from_status] : undefined;
        if (CLOSED.has(s) && observed.sourceLegStatus !== "completed" && entered !== undefined && entered < 2) {
          await move("failed", `PIX_TRANSFER_${s.toUpperCase()}_UNPAID: review closed by GET`);
        }
        return status;
      }
      // Never move backwards: resume relative to the stage the review was entered from.
      // (prior - 0.5) lets the operation return to that same stage but not to an earlier one.
      const prior = (event.from_status ? RANK[event.from_status] : undefined) ?? 1;
      paid = observed.sourceLegStatus === "completed" || prior >= 2;
      rank = prior - 0.5;
      resumeGuard = true;
    } else {
      if (rank === undefined || TERMINAL_STATUSES.has(status)) return status;
      paid = observed.sourceLegStatus === "completed" || rank >= 2;
    }
    const closed = CLOSED.has(s);

    if (status === "accepted") {
      if (closed && !paid) {
        await move(s === "expired" ? "expired" : "failed", `PIX_TRANSFER_${s.toUpperCase()}_UNPAID`);
        return status;
      }
      if (this.e.mode === "live") {
        // The FX lock outcome exists only on the create response: GET cannot confirm it,
        // so instructions are never shown and an operator decides.
        if (!ctx.pix_created_at) throw new Error("PIX_CREATED_AT_MISSING");
        const age = Date.now() - new Date(ctx.pix_created_at).getTime();
        if (age < (this.deps.ambiguousGraceMs ?? 120_000)) return status;
        await move("needs_review", `PIX_LOCK_OUTCOME_UNKNOWN: transfer_status=${s.slice(0, 40)}`);
        return status;
      }
      if (s === "needs_review") { await move("needs_review", OZAV_REVIEW); return status; }
      if (s !== "awaiting_payment" && !paid) return status;
      await move("awaiting_pix", "pix_recovered_by_get");
    }

    // OZAV needs_review is non-terminal (it may still complete): review, never refund.
    if (s === "needs_review") {
      await move("needs_review", OZAV_REVIEW);
      return status;
    }
    if (closed) {
      if (paid) {
        await move("refund_pending", `PAYMENT_RECEIVED_TRANSFER_${s.toUpperCase()}`);
        return this.ensureRefund(purchaseId, ctx, actor);
      }
      // needs_review has no edge to expired: an unpaid end of a resumed review is failed.
      await move(s === "expired" && status !== "needs_review" ? "expired" : "failed", `PIX_TRANSFER_${s.toUpperCase()}_UNPAID`);
      return status;
    }
    if (s === "awaiting_payment") {
      if (status !== "awaiting_pix") return status;
      const limits = [ctx.pix_expires_at ? Date.parse(ctx.pix_expires_at) : NaN,
        ctx.lock_deadline_at ? new Date(ctx.lock_deadline_at).getTime() : NaN].filter(v => !Number.isNaN(v));
      if (!limits.length) return status;
      const deadline = Math.min(...limits);
      // Expire only after the grace period: a payment made right at the deadline is still seen.
      if (deadline + (this.deps.expiryGraceMs ?? 0) <= Date.now()) {
        await move("expired", `PIX_EXPIRED_UNPAID: deadline=${new Date(deadline).toISOString()}${ctx.cancel_requested_at ? `; ${CUSTOMER_CANCEL_REQUESTED}` : ""}`);
      }
      return status;
    }
    if (PAID_PROGRESS.has(s)) {
      if (rank! < 2) await move("pix_confirmed", `transfer_${s}`);
      return status;
    }
    if (s === "completed") {
      if (rank! < 3) {
        const locked = ctx.locked_usdt_amount === null ? null : usdtMicroUnits(ctx.locked_usdt_amount);
        const amount = usdtMicroUnits(observed.amountUsdt);
        if (amount === null || (locked !== null && amount < locked) || (locked === null && this.e.mode === "live")) {
          await move("needs_review", `CONVERTED_AMOUNT_BELOW_LOCK: amount=${String(observed.amountUsdt).slice(0, 40)} locked_usdt_amount=${ctx.locked_usdt_amount}`);
          return status;
        }
        await move("converted", `transfer_completed: amount=${observed.amountUsdt} USDT`);
      }
      if (rank! < 4) {
        try {
          await this.deps.withdrawals.record(ctx.customer_id, systemRequestId(`system-${purchaseId}`), ctx.pix_id!);
        } catch (error) {
          if (!(error instanceof WithdrawalRequestError)) throw error;
          if (error.code !== "WITHDRAWAL_ALREADY_RECORDED") {
            await move("needs_review", `WITHDRAWAL_REQUEST_NOT_RECORDED: ${error.code}`);
            return status;
          }
        }
        await move("awaiting_approval", "withdrawal_request_recorded");
      }
      return status;
    }
    return status;
  }

  /** Exactly one manual refund request per refund_pending operation (refunds are manual at OZAV). */
  private async ensureRefund(purchaseId: string, ctx: Context, actor: ProgressionActor): Promise<OperationStatus> {
    try {
      await this.deps.refunds.request(ctx.customer_id, purchaseId, systemRequestId(`system-refund-${purchaseId}`), REFUND_REASON);
    } catch (error) {
      if (!(error instanceof ManualRefundError)) throw error;
      if (error.code !== "REFUND_ALREADY_REQUESTED") {
        await this.deps.operations.transitionOperation(purchaseId, "needs_review", actor, `REFUND_REQUEST_NOT_RECORDED: ${error.code}`, {from: "refund_pending"});
        return "needs_review";
      }
    }
    return "refund_pending";
  }

  /** GET (list by metadata when unbound, never re-POST), persist, then progress. */
  async refreshPix(customerId: string, pixId: string, actor: ProgressionActor = "system:reconciliation") {
    if (!this.deps.pix) throw new Error("PIX_READER_REQUIRED");
    return refreshPixAndProgress(this.deps.pix.repo, this.deps.pix.provider, this, customerId, pixId, this.deps.mode, actor,
      this.deps.instructionsMarginMs ?? 0);
  }

  /**
   * Final review I3: a claimed Pix create for which the list by metadata found no transfer.
   * Expires the accepted operation once the claim is older than the grace period. Under the
   * purchase row lock, only while the operation is still accepted and the Pix has no transfer.
   */
  async expireCreateNotFound(purchaseId: string, actor: ProgressionActor = "system:reconciliation"): Promise<boolean> {
    const grace = this.deps.createNotFoundGraceMs ?? DEFAULT_CREATE_NOT_FOUND_GRACE_MS;
    const r = await this.deps.pool.query(`with c as (
       select p.id,p.customer_id from peragus_customer_purchase_intents p
       join peragus_customer_sandbox_pix x on x.purchase_intent_id=p.id and x.customer_id=p.customer_id and x.environment=p.environment
       where p.id=$1 and p.environment='${this.e.mode}' and p.status='accepted' and x.create_attempted and x.provider_transfer_id is null
        and x.updated_at<=now()-make_interval(secs=>$2::double precision/1000)
       for update of p
     ), u as (update peragus_customer_purchase_intents p set status='expired' from c where p.id=c.id and p.status='accepted' returning p.id,p.customer_id)
     insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
     select id,customer_id,'accepted','expired',$3,'PIX_CREATE_NOT_FOUND_AFTER_GRACE: no OZAV transfer listed by metadata','${this.e.mode}' from u
     returning purchase_id`, [purchaseId, grace, actor]);
    return r.rows.length === 1;
  }

  /**
   * Final review I3: accepted operations whose Pix create was never claimed expire after the
   * TTL (ACCEPTED_OPERATION_TTL_MINUTES). The purchase row lock is the one the Pix claim
   * takes: a claim in flight is skipped (skip locked), a committed claim excludes the row.
   */
  async expireAbandonedAccepted(ttlMs: number, actor: ProgressionActor = "system:reconciliation"): Promise<number> {
    const r = await this.deps.pool.query(`with c as (
       select p.id,p.customer_id from peragus_customer_purchase_intents p
       where p.environment='${this.e.mode}' and p.status='accepted' and p.status_changed_at<=now()-make_interval(secs=>$1::double precision/1000)
        and not exists(select 1 from peragus_customer_sandbox_pix x where x.purchase_intent_id=p.id and x.customer_id=p.customer_id and x.create_attempted)
       order by p.status_changed_at,p.id limit 50 for update of p skip locked
     ), u as (update peragus_customer_purchase_intents p set status='expired' from c where p.id=c.id and p.status='accepted' returning p.id,p.customer_id)
     insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
     select id,customer_id,'accepted','expired',$2,'ACCEPTED_TTL_EXPIRED_NO_PIX','${this.e.mode}' from u
     returning purchase_id`, [ttlMs, actor]);
    return r.rows.length;
  }

  /**
   * Webhook entry: the event only names which transfer to re-read. The bound
   * transfer id is looked up locally; an unbound charge may be named by the
   * metadata hint, and is then recovered by the same list-by-metadata GET.
   */
  async refreshTransfer(transferId: string, pixHint: string | null, actor: ProgressionActor = "system:webhook"): Promise<"processed" | "ignored"> {
    const r = await this.deps.pool.query<{id: string; customer_id: string}>(`select id,customer_id from peragus_customer_sandbox_pix
      where environment='${this.e.mode}' and create_attempted and (provider_transfer_id=$1
       or ($2::uuid is not null and id=$2::uuid and provider_transfer_id is null)) order by provider_transfer_id nulls last limit 1`,
      [transferId, pixHint && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pixHint) ? pixHint : null]);
    const row = r.rows[0];
    if (!row) return "ignored";
    await this.refreshPix(row.customer_id, row.id, actor);
    return "processed";
  }
}

/** Shared by reconciliation and webhooks: GET-only recovery followed by progression. */
export async function refreshPixAndProgress(
  repo: Pick<CustomerPixRepository, "read" | "bind" | "save">, provider: PixProvider,
  progression: Pick<PurchaseProgression, "applyTransferObservation"> & Partial<Pick<PurchaseProgression, "expireCreateNotFound">>,
  customerId: string, pixId: string, mode: MoneyMode, actor: ProgressionActor = "system:reconciliation", marginMs = 0,
) {
  const view = await reconcileCustomerPix(repo, provider, customerId, pixId, mode, marginMs);
  const row = await repo.read(customerId, pixId);
  const t = row?.observation;
  if (!row) return view;
  if (!t) {
    // Claimed create, no transfer listed by metadata: expire after the grace period (I3).
    if (row.attempted && !row.transferId && row.operationStatus === "accepted" && progression.expireCreateNotFound
      && await progression.expireCreateNotFound(row.purchaseId, actor)) return pixView((await repo.read(customerId, pixId)) ?? row, mode, marginMs);
    return view;
  }
  await progression.applyTransferObservation(row.purchaseId,
    {status: t.status, amountUsdt: t.amounts.target.amount, sourceLegStatus: t.sourceLegStatus}, actor);
  return pixView((await repo.read(customerId, pixId)) ?? row, mode, marginMs);
}
