import type {OperationStatus} from "./operation-status.js";
import type {PurchaseProgression} from "./purchase-progression.js";

export class CustomerPurchaseCancelError extends Error {
  constructor(public readonly code: "CANCEL_NOT_FOUND" | "CANCEL_NOT_ALLOWED" | "CANCEL_TOO_LATE_PAYMENT_RECEIVED"
    | "CANCEL_IDEMPOTENCY_CONFLICT") { super(code); }
}
/** Event reasons (peragus_operation_status_events). */
export const CUSTOMER_CANCELLED = "CUSTOMER_CANCELLED";
export const CUSTOMER_CANCEL_REQUESTED = "CUSTOMER_CANCEL_REQUESTED";
export const CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT = "CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT";

export interface PurchaseCancelState {
  purchaseId: string; status: OperationStatus;
  cancelRequestedAt: string | null; cancelRequestId: string | null;
  /** A payment confirmed after the request withdrew it (the purchase proceeds). */
  cancelWithdrawn: boolean;
  /** The Pix charge funding the purchase, if one was reserved. */
  pix: {id: string; attempted: boolean; paid: boolean} | null;
}
export type CancelOutcome = {kind: "recorded"; state: PurchaseCancelState} | {kind: "refused"; state: PurchaseCancelState};
export interface PurchaseCancelRepository {
  read(customerId: string, purchaseId: string): Promise<PurchaseCancelState | null>;
  /** True when this customer already used requestId to cancel another purchase. */
  requestUsedElsewhere(customerId: string, purchaseId: string, requestId: string): Promise<boolean>;
  /**
   * Under the purchase row lock: when the operation is still accepted, uncancelled and
   * no Pix create was claimed, records the request and expires it (CUSTOMER_CANCELLED).
   * "refused" carries the state read under the lock otherwise.
   */
  cancelUnfunded(customerId: string, purchaseId: string, requestId: string, actor: string): Promise<CancelOutcome>;
  /**
   * Under the purchase row lock: when the operation is still accepted or awaiting_pix,
   * uncancelled and its stored Pix observation is not paid, records the request and one
   * note event (status unchanged). "refused" carries the state read under the lock.
   */
  recordRequest(customerId: string, purchaseId: string, requestId: string, actor: string): Promise<CancelOutcome>;
}
type Refresher = Pick<PurchaseProgression, "refreshPix">;
const CANCELLABLE: ReadonlySet<OperationStatus> = new Set(["accepted", "awaiting_pix"]);
// From pix_confirmed onwards the Pix was received: policy 7.2, no voluntary cancel.
const PAID_STAGES: ReadonlySet<OperationStatus> = new Set(["pix_confirmed", "converted", "awaiting_approval", "approved",
  "sending", "sent", "delivered_verified"]);

const view = (s: PurchaseCancelState) => ({purchase_id: s.purchaseId, status: s.status, cancel_requested_at: s.cancelRequestedAt});

/**
 * Customer cancel before Pix payment (refund policy 7.1). OZAV has no transfer-cancel
 * endpoint, so a cancel never closes a purchase that has a Pix: it is recorded only
 * after a fresh GET shows the payment not received, hides the instructions, and the
 * operation expires as usual; a payment arriving before then withdraws it. An accepted
 * purchase without a claimed Pix create is expired at once (nothing payable exists).
 */
export class CustomerPurchaseCancelService {
  constructor(private readonly repo: PurchaseCancelRepository, private readonly progression: Refresher) {}

  private refuse(s: PurchaseCancelState): never {
    throw new CustomerPurchaseCancelError(PAID_STAGES.has(s.status) || s.pix?.paid ? "CANCEL_TOO_LATE_PAYMENT_RECEIVED" : "CANCEL_NOT_ALLOWED");
  }

  /**
   * A cancel request already exists. The same request_id always replays it; another one
   * gets the same answer while the request stands, and is refused once a payment withdrew it.
   */
  private existing(s: PurchaseCancelState, requestId: string) {
    if (s.cancelRequestId !== requestId && s.cancelWithdrawn) throw new CustomerPurchaseCancelError("CANCEL_TOO_LATE_PAYMENT_RECEIVED");
    return {data: view(s), replayed: true};
  }

  async cancel(customerId: string, purchaseId: string, requestId: string) {
    let state = await this.repo.read(customerId, purchaseId);
    if (!state) throw new CustomerPurchaseCancelError("CANCEL_NOT_FOUND");
    if (state.cancelRequestedAt) return this.existing(state, requestId);
    if (await this.repo.requestUsedElsewhere(customerId, purchaseId, requestId)) throw new CustomerPurchaseCancelError("CANCEL_IDEMPOTENCY_CONFLICT");
    if (!CANCELLABLE.has(state.status)) this.refuse(state);
    const actor = `customer:${customerId}`;
    if (state.status === "accepted" && !state.pix?.attempted) {
      const outcome = await this.repo.cancelUnfunded(customerId, purchaseId, requestId, actor);
      if (outcome.kind === "recorded") return {data: view(outcome.state), replayed: false};
      // A Pix create was claimed (or the status moved) meanwhile: decide again from GET.
      state = outcome.state;
      if (state.cancelRequestedAt) return this.existing(state, requestId);
      if (!CANCELLABLE.has(state.status)) this.refuse(state);
    }
    if (state.pix?.attempted) {
      // Fresh GET (never a POST) and progression: a received payment is never cancellable.
      // A GET failure propagates and records nothing.
      await this.progression.refreshPix(customerId, state.pix.id);
      state = await this.repo.read(customerId, purchaseId);
      if (!state) throw new CustomerPurchaseCancelError("CANCEL_NOT_FOUND");
      if (state.cancelRequestedAt) return this.existing(state, requestId);
      if (!CANCELLABLE.has(state.status) || state.pix?.paid) this.refuse(state);
    }
    const outcome = await this.repo.recordRequest(customerId, purchaseId, requestId, actor);
    if (outcome.kind === "refused") {
      if (outcome.state.cancelRequestedAt) return this.existing(outcome.state, requestId);
      this.refuse(outcome.state);
    }
    return {data: view(outcome.state), replayed: false};
  }
}
