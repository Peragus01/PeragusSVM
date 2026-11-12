import {createHash} from "node:crypto";
import type {Pool} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import type {OzavClient} from "../providers/ozav-client.js";
import {usdtMicroUnits} from "../quotes/customer-quotes.js";
import {ManualRefundError,type ManualRefundService} from "../refunds/manual-refunds.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {WithdrawalRequestError,type WithdrawalRequestRepository} from "../withdrawals/customer-withdrawal-requests.js";
import type {PurchaseIntentRepository} from "./customer-purchase-intents.js";
import {pixView,reconcileCustomerPix,type CustomerPixRepository} from "./customer-sandbox-pix.js";
import {TERMINAL_STATUSES,type OperationStatus} from "./operation-status.js";

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
}

// RFC 4122 name-based (SHA-1, v5) UUID in a fixed Peragus namespace: request_id
// columns are uuid, so `system-<purchaseId>` is stored as its deterministic UUID.
const NAMESPACE = Buffer.from("8f0d5a4e2c7b4e1f9a63d1b07c5e2f48", "hex");
export function systemRequestId(name: string): string {
  const h = createHash("sha1").update(NAMESPACE).update(name, "utf8").digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const REFUND_REASON = "Automatic request: the Pix payment was received but the OZAV transfer did not complete.";
const CLOSED = new Set(["failed", "cancelled", "expired", "needs_review"]);
const PAID_PROGRESS = new Set(["payment_confirmed", "converting", "payout_initiated"]);
// Funding stages this module moves forward; anything later belongs to the operator/send path.
const RANK: Partial<Record<OperationStatus, number>> = {accepted: 0, awaiting_pix: 1, pix_confirmed: 2, converted: 3, awaiting_approval: 4};
interface Context {
  status: OperationStatus; customer_id: string; locked_usdt_amount: string | null;
  pix_id: string | null; pix_created_at: Date | string | null; lock_deadline_at: Date | string | null; pix_expires_at: string | null;
}

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
      x.id as pix_id,x.created_at as pix_created_at,x.lock_deadline_at,
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
   * failed|cancelled|expired|needs_review -> refund_pending when paid (+ one manual refund
   * request), otherwise failed|expired|needs_review. Returns the resulting status.
   */
  async applyTransferObservation(purchaseId: string, observed: TransferObservation,
    actor: ProgressionActor = "system:reconciliation"): Promise<OperationStatus> {
    const ctx = await this.context(purchaseId);
    if (!ctx) throw new Error("PURCHASE_INTENT_NOT_FOUND");
    let status = ctx.status;
    const move = async (to: OperationStatus, reason: string) => {
      await this.deps.operations.transitionOperation(purchaseId, to, actor, reason);
      status = to;
    };
    if (status === "refund_pending") return this.ensureRefund(purchaseId, ctx, actor);
    const rank = RANK[status];
    if (rank === undefined || TERMINAL_STATUSES.has(status)) return status;
    const s = observed.status;
    const paid = observed.sourceLegStatus === "completed" || rank >= 2;
    const closed = CLOSED.has(s);

    if (status === "accepted") {
      if (closed && !paid) {
        await move(s === "expired" ? "expired" : s === "needs_review" ? "needs_review" : "failed", `PIX_TRANSFER_${s.toUpperCase()}_UNPAID`);
        return status;
      }
      if (this.e.mode === "live") {
        // The FX lock outcome exists only on the create response: GET cannot confirm it,
        // so instructions are never shown and an operator decides.
        const age = ctx.pix_created_at ? Date.now() - new Date(ctx.pix_created_at).getTime() : 0;
        if (age < (this.deps.ambiguousGraceMs ?? 120_000)) return status;
        await move("needs_review", `PIX_LOCK_OUTCOME_UNKNOWN: transfer_status=${s.slice(0, 40)}`);
        return status;
      }
      if (s !== "awaiting_payment" && !paid) return status;
      await move("awaiting_pix", "pix_recovered_by_get");
    }

    if (closed) {
      if (paid) {
        await move("refund_pending", `PAYMENT_RECEIVED_TRANSFER_${s.toUpperCase()}`);
        return this.ensureRefund(purchaseId, ctx, actor);
      }
      await move(s === "expired" ? "expired" : s === "needs_review" ? "needs_review" : "failed", `PIX_TRANSFER_${s.toUpperCase()}_UNPAID`);
      return status;
    }
    if (s === "awaiting_payment") {
      if (status !== "awaiting_pix") return status;
      const limits = [ctx.pix_expires_at ? Date.parse(ctx.pix_expires_at) : NaN,
        ctx.lock_deadline_at ? new Date(ctx.lock_deadline_at).getTime() : NaN].filter(v => !Number.isNaN(v));
      if (!limits.length) return status;
      const deadline = Math.min(...limits);
      if (deadline <= Date.now()) await move("expired", `PIX_EXPIRED_UNPAID: deadline=${new Date(deadline).toISOString()}`);
      return status;
    }
    if (PAID_PROGRESS.has(s)) {
      if (RANK[status]! < 2) await move("pix_confirmed", `transfer_${s}`);
      return status;
    }
    if (s === "completed") {
      if (RANK[status]! < 3) {
        const locked = ctx.locked_usdt_amount === null ? null : usdtMicroUnits(ctx.locked_usdt_amount);
        const amount = usdtMicroUnits(observed.amountUsdt);
        if (amount === null || (locked !== null && amount < locked) || (locked === null && this.e.mode === "live")) {
          await move("needs_review", `CONVERTED_AMOUNT_BELOW_LOCK: amount=${String(observed.amountUsdt).slice(0, 40)} locked_usdt_amount=${ctx.locked_usdt_amount}`);
          return status;
        }
        await move("converted", `transfer_completed: amount=${observed.amountUsdt} USDT`);
      }
      if (RANK[status]! < 4) {
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
        await this.deps.operations.transitionOperation(purchaseId, "needs_review", actor, `REFUND_REQUEST_NOT_RECORDED: ${error.code}`);
        return "needs_review";
      }
    }
    return "refund_pending";
  }

  /** GET (list by metadata when unbound, never re-POST), persist, then progress. */
  async refreshPix(customerId: string, pixId: string, actor: ProgressionActor = "system:reconciliation") {
    if (!this.deps.pix) throw new Error("PIX_READER_REQUIRED");
    return refreshPixAndProgress(this.deps.pix.repo, this.deps.pix.provider, this, customerId, pixId, this.deps.mode, actor);
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
      [transferId, pixHint && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pixHint) ? pixHint : null]);
    const row = r.rows[0];
    if (!row) return "ignored";
    await this.refreshPix(row.customer_id, row.id, actor);
    return "processed";
  }
}

/** Shared by reconciliation and webhooks: GET-only recovery followed by progression. */
export async function refreshPixAndProgress(
  repo: Pick<CustomerPixRepository, "read" | "bind" | "save">, provider: PixProvider,
  progression: Pick<PurchaseProgression, "applyTransferObservation">,
  customerId: string, pixId: string, mode: MoneyMode, actor: ProgressionActor = "system:reconciliation",
) {
  const view = await reconcileCustomerPix(repo, provider, customerId, pixId, mode);
  const row = await repo.read(customerId, pixId);
  const t = row?.observation;
  if (!row || !t) return view;
  await progression.applyTransferObservation(row.purchaseId,
    {status: t.status, amountUsdt: t.amounts.target.amount, sourceLegStatus: t.sourceLegStatus}, actor);
  return pixView((await repo.read(customerId, pixId)) ?? row, mode);
}
