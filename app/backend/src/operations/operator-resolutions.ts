import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import type {MoneyMode} from "../config/money-environment.js";
import type {OzavClient} from "../providers/ozav-client.js";
import type {OzavSandboxWithdrawalProvider} from "../providers/ozav-sandbox-withdrawal.js";
import {validatePixTransfer,type CustomerPixRepository} from "../purchases/customer-sandbox-pix.js";
import type {OperationStatus} from "../purchases/operation-status.js";
import type {PurchaseProgression} from "../purchases/purchase-progression.js";
import {refundReason} from "../refunds/manual-refunds.js";
import {transitionOperationInTransaction} from "../repositories/postgres-customer-purchase-intents.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {authorizeWithdrawalOperator,defaultOperatorMfaPolicy,requireFreshMfa,type OperatorMfaPolicy} from "../withdrawals/operator-approvals.js";
import {reverifyExecution,type DeliveryCheck,type SandboxExecutionRepository} from "../withdrawals/sandbox-execution.js";

export class OperatorResolutionError extends Error {constructor(public readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new OperatorResolutionError(code);};
export type ResolutionAction="close_unpaid_review"|"reverify_delivery"|"return_approved_to_review";
const CLOSED=new Set(["failed","cancelled","expired"]);

export interface OperatorResolutionDeps {
 pool:Pick<Pool,"query"|"connect">;
 mode:MoneyMode;
 operators:ReadonlySet<string>;
 policy?:Partial<OperatorMfaPolicy>;
 /** GET-only Pix access. */
 pix:{repo:Pick<CustomerPixRepository,"read"|"bind"|"save">;provider:Pick<OzavClient,"findCustomerPixTransfer"|"getTransfer">};
 /** Progression (GET + local moves) for the "reconciliar Pix" action. */
 progression?:Pick<PurchaseProgression,"refreshPix">;
 /** Send re-verification; absent when the send path is not configured. */
 delivery?:{repo:Pick<SandboxExecutionRepository,"read"|"save"|"reverifyDelivery"|"recordDeliveryPending">;
  provider:Pick<OzavSandboxWithdrawalProvider,"transfer">;check:DeliveryCheck};
}
interface ResolutionRow {id:string;purchase_id:string;action:string;reason:string;from_status:string;to_status:string;outcome:string;created_at:Date|string}
const view=(r:ResolutionRow)=>({id:r.id,purchase_id:r.purchase_id,action:r.action,from_status:r.from_status,to_status:r.to_status,
 outcome:r.outcome,created_at:new Date(r.created_at).toISOString()});

/**
 * Ruling 39: audited operator resolutions (allowlist + fresh TOTP + reason, idempotent per
 * operator + request_id). There is no manual "mark as delivered": re-verification re-runs
 * the same on-chain check. Every status move happens under the purchase row lock with the
 * expected from-status, and the database guard validates it again.
 */
export class OperatorResolutionService {
 private readonly e:RowEnvironment;
 private readonly policy:OperatorMfaPolicy;
 constructor(private readonly deps:OperatorResolutionDeps){this.e=rowEnvironment(deps.mode);this.policy=defaultOperatorMfaPolicy(deps.policy);}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.deps.operators);}
 private guard(user:AuthenticatedUser,reason:string){
  this.authorize(user);requireFreshMfa(user,this.policy.mfaMaxAgeSeconds,this.policy.now()/1000);
  const parsed=refundReason.safeParse(reason);if(!parsed.success)fail("RESOLUTION_REASON_INVALID");
  return parsed.data!;
 }
 private async prior(user:AuthenticatedUser,requestId:string,purchaseId:string,action:ResolutionAction,reason:string){
  const r=await this.deps.pool.query<ResolutionRow>("select * from peragus_operator_resolutions where operator_user_id=$1 and request_id=$2",[user.id,requestId]);
  const row=r.rows[0];if(!row)return null;
  if(row.purchase_id!==purchaseId || row.action!==action || row.reason!==reason)fail("RESOLUTION_IDEMPOTENCY_CONFLICT");
  return {data:view(row),replayed:true};
 }
 private async operation(purchaseId:string){
  const r=await this.deps.pool.query<{status:OperationStatus;customer_id:string}>(`select status,customer_id from peragus_customer_purchase_intents where id=$1 and environment='${this.e.mode}'`,[purchaseId]);
  return r.rows[0]??fail("RESOLUTION_OPERATION_NOT_FOUND");
 }
 private async lastTransition(q:Pick<Pool,"query">,purchaseId:string){
  const r=await q.query<{from_status:OperationStatus|null;reason:string}>(`select from_status,reason from peragus_operation_status_events
   where purchase_id=$1 and from_status is distinct from to_status order by id desc limit 1`,[purchaseId]);
  return r.rows[0]??null;
 }
 private async insert(q:Pick<Pool,"query">,user:AuthenticatedUser,input:{purchaseId:string;customerId:string;requestId:string;action:ResolutionAction;
  reason:string;from:string;to:string;outcome:string}){
  const r=await q.query<ResolutionRow>(`insert into peragus_operator_resolutions(id,purchase_id,customer_id,operator_user_id,request_id,action,reason,from_status,to_status,outcome,environment)
   select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'${this.e.mode}' where not exists(select 1 from peragus_customers where owner_user_id=$4) returning *`,
   [randomUUID(),input.purchaseId,input.customerId,user.id,input.requestId,input.action,input.reason,input.from,input.to,
    input.outcome.replace(/[\u0000-\u001f\u007f]/g," ").slice(0,200)]);
  return r.rows[0]??fail("OPERATOR_ACCOUNT_SEPARATION_REQUIRED");
 }
 private async transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.deps.pool.connect();let broken:Error|undefined;
  try{
   await client.query("begin isolation level read committed");
   const value=await work(client);
   await client.query("commit");
   return value;
  }catch(error){
   try{await client.query("rollback");}catch(rollbackError){broken=rollbackError instanceof Error?rollbackError:new Error("ROLLBACK_FAILED");}
   if(error && typeof error==="object" && "message" in error && String((error as Error).message).includes("operator_user_id_request_id"))fail("RESOLUTION_IDEMPOTENCY_CONFLICT");
   throw error;
  }finally{(client as PoolClient).release(broken);}
 }

 /**
  * Closes an unpaid needs_review (e.g. PIX_LOCK_OUTCOME_UNKNOWN) as failed, only after a GET
  * confirms that the OZAV Pix transfer is terminal (failed/cancelled/expired) and unpaid.
  */
 async closeUnpaidReview(user:AuthenticatedUser,purchaseId:string,requestId:string,reason:string){
  reason=this.guard(user,reason);
  const replay=await this.prior(user,requestId,purchaseId,"close_unpaid_review",reason);if(replay)return replay;
  const op=await this.operation(purchaseId);
  if(op.status!=="needs_review")fail("RESOLUTION_OPERATION_NOT_IN_REVIEW");
  const pix=await this.deps.pool.query<{id:string}>(`select id from peragus_customer_sandbox_pix where purchase_intent_id=$1 and customer_id=$2 and environment='${this.e.mode}'`,[purchaseId,op.customer_id]);
  const pixId=pix.rows[0]?.id??fail("RESOLUTION_PIX_TRANSFER_NOT_FOUND");
  const row=(await this.deps.pix.repo.read(op.customer_id,pixId))??fail("RESOLUTION_PIX_TRANSFER_NOT_FOUND");
  const transferId=row.transferId??(row.attempted?await this.deps.pix.provider.findCustomerPixTransfer(row.providerCustomerId,row.id):null);
  if(!transferId)fail("RESOLUTION_PIX_TRANSFER_NOT_FOUND");
  const t=await this.deps.pix.provider.getTransfer(transferId!);
  validatePixTransfer(row,t);
  await this.deps.pix.repo.bind(row,transferId!);row.transferId=transferId!;
  await this.deps.pix.repo.save(row,t);
  if(!CLOSED.has(t.status) || t.sourceLegStatus==="completed")fail("RESOLUTION_TRANSFER_NOT_TERMINAL_UNPAID");
  const outcome=`PIX_TRANSFER_${t.status.toUpperCase()}_UNPAID: closed by operator`;
  const saved=await this.transaction(async client=>{
   await transitionOperationInTransaction(client,this.deps.mode,purchaseId,"failed",`operator:${user.id}`,
    `OPERATOR_CLOSED_UNPAID_REVIEW: transfer_status=${t.status}`,{from:"needs_review"});
   return this.insert(client,user,{purchaseId,customerId:op.customer_id,requestId,action:"close_unpaid_review",reason,from:"needs_review",to:"failed",outcome});
  });
  return {data:view(saved),replayed:false};
 }

 /**
  * Re-runs the on-chain delivery check (current tolerance and RPC, the same Ruling 30 checks)
  * for a `sent` operation or a delivery review entered from `sent`. It may move the operation
  * to delivered_verified; it never marks a delivery by hand.
  */
 async reverifyDelivery(user:AuthenticatedUser,purchaseId:string,requestId:string,reason:string){
  reason=this.guard(user,reason);
  const replay=await this.prior(user,requestId,purchaseId,"reverify_delivery",reason);if(replay)return replay;
  if(!this.deps.delivery)fail("RESOLUTION_DELIVERY_CHECK_UNAVAILABLE");
  const op=await this.operation(purchaseId);
  if(op.status!=="sent" && !(op.status==="needs_review" && (await this.lastTransition(this.deps.pool,purchaseId))?.from_status==="sent"))
   fail("RESOLUTION_OPERATION_NOT_DELIVERY_REVIEW");
  const w=await this.deps.pool.query<{id:string}>(`select w.id from peragus_customer_withdrawal_requests w
   join peragus_sandbox_withdrawal_executions e on e.withdrawal_request_id=w.id and e.customer_id=w.customer_id
   where w.purchase_intent_id=$1 and w.customer_id=$2 and w.environment='${this.e.mode}'`,[purchaseId,op.customer_id]);
  const execution=(w.rows[0]?await this.deps.delivery!.repo.read(w.rows[0].id):null)??fail("RESOLUTION_EXECUTION_NOT_FOUND");
  const result=await reverifyExecution(this.deps.delivery!.repo,this.deps.delivery!.provider,execution,`operator:${user.id}`,this.deps.delivery!.check);
  const after=await this.operation(purchaseId);
  const outcome=result.outcome?`${result.outcome.status.toUpperCase()}: ${result.outcome.reason}`:"PENDING: SEND_NOT_COMPLETED";
  const saved=await this.insert(this.deps.pool,user,{purchaseId,customerId:op.customer_id,requestId,action:"reverify_delivery",reason,
   from:op.status,to:after.status,outcome});
  return {data:{...view(saved),execution:result.view},replayed:false};
 }

 /**
  * R38 path for an `approved` operation with a permanent blocker (e.g. no token account):
  * back to needs_review, only while no send was claimed; the refund decision may follow.
  */
 async returnApprovedToReview(user:AuthenticatedUser,purchaseId:string,requestId:string,reason:string){
  reason=this.guard(user,reason);
  const replay=await this.prior(user,requestId,purchaseId,"return_approved_to_review",reason);if(replay)return replay;
  const op=await this.operation(purchaseId);
  if(op.status!=="approved")fail("RESOLUTION_OPERATION_NOT_APPROVED");
  const saved=await this.transaction(async client=>{
   // Same lock the send claim takes; a claimed send (create_attempted) refuses.
   await client.query(`select id from peragus_customer_purchase_intents where id=$1 and environment='${this.e.mode}' for update`,[purchaseId]);
   const claimed=await client.query(`select 1 from peragus_sandbox_withdrawal_executions e join peragus_customer_withdrawal_requests w
    on w.id=e.withdrawal_request_id and w.customer_id=e.customer_id where w.purchase_intent_id=$1 and e.create_attempted limit 1`,[purchaseId]);
   if(claimed.rows[0])fail("REFUND_WITHDRAWAL_IN_PROGRESS");
   const blocker=await client.query<{blocker:string|null}>(`select c.blocker from peragus_withdrawal_destination_checks c join peragus_customer_withdrawal_requests w
    on w.id=c.withdrawal_request_id and w.customer_id=c.customer_id where w.purchase_intent_id=$1`,[purchaseId]);
   const code=blocker.rows[0]?.blocker??"OPERATOR_SEND_BLOCKED";
   await transitionOperationInTransaction(client,this.deps.mode,purchaseId,"needs_review",`operator:${user.id}`,
    `OPERATOR_RETURNED_APPROVED_TO_REVIEW: ${code}`,{from:"approved"});
   return this.insert(client,user,{purchaseId,customerId:op.customer_id,requestId,action:"return_approved_to_review",reason,from:"approved",to:"needs_review",outcome:code});
  });
  return {data:view(saved),replayed:false};
 }

 /** "Reconciliar Pix": GET (list by metadata when unbound) and progression. Never POSTs. */
 async reconcilePix(user:AuthenticatedUser,purchaseId:string){
  this.authorize(user);
  if(!this.deps.progression)fail("RESOLUTION_PROGRESSION_UNAVAILABLE");
  const op=await this.operation(purchaseId);
  const pix=await this.deps.pool.query<{id:string}>(`select id from peragus_customer_sandbox_pix where purchase_intent_id=$1 and customer_id=$2 and environment='${this.e.mode}'`,[purchaseId,op.customer_id]);
  const pixId=pix.rows[0]?.id??fail("RESOLUTION_PIX_TRANSFER_NOT_FOUND");
  const pixView=await this.deps.progression!.refreshPix(op.customer_id,pixId!,"system:reconciliation");
  const after=await this.operation(purchaseId);
  return {data:{purchase_id:purchaseId,status:after.status,pix_state:pixView.state,payment_confirmed:pixView.payment_confirmed}};
 }

 async list(user:AuthenticatedUser,purchaseId:string){
  this.authorize(user);
  const r=await this.deps.pool.query<ResolutionRow>(`select * from peragus_operator_resolutions where purchase_id=$1 and environment='${this.e.mode}' order by created_at,id`,[purchaseId]);
  return {data:r.rows.map(view)};
 }
}
