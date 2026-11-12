import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {z} from "zod";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {authorizeWithdrawalOperator,defaultOperatorMfaPolicy,requireFreshMfa,type OperatorMfaPolicy} from "../withdrawals/operator-approvals.js";
import {OperationHistoryInputError,parseHistoryQuery} from "../purchases/customer-operation-history.js";
import {SYSTEM_REFUND_REASON,systemRequestId} from "../purchases/system-request-id.js";
export class ManualRefundError extends Error {constructor(public readonly code:string){super(code);}}
function fail(code:string):never{throw new ManualRefundError(code);}
const iso=(date:Date|string|null)=>date?new Date(date).toISOString():null;
export const refundReason=z.string().trim().min(10).max(500).regex(/^[^\x00-\x1f\x7f]+$/);
export const decisionReason=refundReason.max(300);
export const refundReference=z.string().trim().min(8).max(160).regex(/^[^\x00-\x1f\x7f]+$/);
export const refundAmount=z.string().regex(/^\d{1,15}(\.\d{1,2})?$/).refine(value=>/[1-9]/.test(value));
const cents=(value:string)=>{const [whole,fraction=""]=value.split(".");return BigInt(whole!)*100n+BigInt(fraction.padEnd(2,"0"));};
const normalized=(value:string)=>{const n=cents(value);return `${n/100n}.${String(n%100n).padStart(2,"0")}`;};
interface Row {
 id:string;customer_id:string;purchase_intent_id:string;pix_id:string;request_id:string;reason:string;amount_brl:string;created_at:Date|string;cursor_time:string;
 decision_id:string|null;decision:string|null;decision_request_id:string|null;decision_operator:string|null;decision_reason:string|null;decision_at:Date|string|null;
 completion_id:string|null;completion_request_id:string|null;completion_operator:string|null;returned_amount:string|null;reference:string|null;completion_at:Date|string|null;
 withdrawal_state:string|null;withdrawal_attempted:boolean|null;
}
const select=`select r.*,to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time,
 d.id as decision_id,d.decision,d.request_id as decision_request_id,d.operator_user_id as decision_operator,d.reason as decision_reason,d.created_at as decision_at,
 c.id as completion_id,c.request_id as completion_request_id,c.operator_user_id as completion_operator,c.amount_brl as returned_amount,c.reference,c.created_at as completion_at,
 e.observation->>'status' as withdrawal_state,e.create_attempted as withdrawal_attempted
 from peragus_customer_refund_requests r
 left join peragus_manual_refund_decisions d on d.refund_request_id=r.id and d.customer_id=r.customer_id
 left join peragus_manual_refund_completions c on c.refund_request_id=r.id and c.customer_id=r.customer_id
 left join peragus_customer_withdrawal_requests w on w.purchase_intent_id=r.purchase_intent_id and w.customer_id=r.customer_id
 left join peragus_sandbox_withdrawal_executions e on e.withdrawal_request_id=w.id and e.customer_id=r.customer_id`;
const state=(r:Row)=>r.completion_id?"refund_recorded":r.decision??"pending_review";
function view(r:Row,e:RowEnvironment,operator=false){return {
 id:r.id,purchase_intent_id:r.purchase_intent_id,pix_id:r.pix_id,request_id:r.request_id,state:state(r),reason:r.reason,
 requested_amount:{currency:"BRL",amount:r.amount_brl},created_at:iso(r.created_at),decision_recorded_at:iso(r.decision_at),
 returned_amount:r.returned_amount?{currency:"BRL",amount:r.returned_amount}:null,
 partial_refund:r.returned_amount?cents(r.returned_amount)<cents(r.amount_brl):null,
 refund_recorded_at:iso(r.completion_at),environment:e.mode,record_only:true,refund_execution_automated:false,
 provider_verified:false,original_transfer_cancelled:false,
 ...(operator?{customer_id:r.customer_id,decision:r.decision_id?{id:r.decision_id,operator_user_id:r.decision_operator,reason:r.decision_reason}:null,
 completion:r.completion_id?{id:r.completion_id,operator_user_id:r.completion_operator,reference:r.reference}:null,
 withdrawal_context:{started:r.withdrawal_attempted===true,provider_state:r.withdrawal_state,requires_manual_funds_review:r.withdrawal_attempted===true}}:{})
};}

/** All writes are local append-only evidence; this class has no provider/queue/signer. */
export class ManualRefundService {
 private readonly e:RowEnvironment;
 private readonly policy:OperatorMfaPolicy;
 /** `pool.connect` is used only by operationDecision (one transaction under the purchase row lock). */
 constructor(private readonly pool:Pick<Pool,"query"|"connect">,private readonly operators:ReadonlySet<string>,private readonly enabled:boolean,mode:MoneyMode,
  /** true: a completion requires a refund_pending operation and moves it to refunded atomically. */
  private readonly settleOperations=false,
  /** Fresh-TOTP window for the money-moving actions (operationDecision, complete). */
  policy:Partial<OperatorMfaPolicy>={}){this.e=rowEnvironment(mode);this.policy=defaultOperatorMfaPolicy(policy);}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.operators);}
 private requireFreshMfa(user:AuthenticatedUser){requireFreshMfa(user,this.policy.mfaMaxAgeSeconds,this.policy.now()/1000);}
 private writable(){if(!this.enabled)fail("MANUAL_REFUNDS_DISABLED");}
 private async one(where:string,args:unknown[],q:Pick<Pool,"query">=this.pool){const r=await q.query<Row>(`${select} where r.environment='${this.e.mode}' and ${where}`,args);return r.rows[0]??null;}
 async customerRead(customerId:string,purchaseId:string){
  const row=await this.one("r.customer_id=$1 and r.purchase_intent_id=$2",[customerId,purchaseId]);
  if(!row)fail("REFUND_REQUEST_NOT_FOUND");return view(row,this.e);
 }
 async request(customerId:string,purchaseId:string,requestId:string,reason:string){
  this.writable();
  return this.record(customerId,purchaseId,requestId,reason);
 }
 /**
  * Operator refund decision on an operation (controller ruling 22): moves it to
  * refund_pending from needs_review, pix_confirmed, converted or awaiting_approval, or
  * from expired/failed, always requiring the Pix source leg recorded as completed (the
  * refund request needs that payment evidence; for expired/failed the SQL status guard
  * enforces it too). The lock, checks, decision record, status change and audit event
  * are ONE statement. Idempotent per operator + request_id; creates (or reuses) the
  * manual refund request, recorded even when MANUAL_REFUNDS_ENABLED is off.
  * Ruling 23: refused with REFUND_WITHDRAWAL_IN_PROGRESS when a withdrawal approval or
  * execution exists (checked under the same purchase row lock the approval takes).
  * Requires a fresh TOTP. The statement, the refund request and the read run in ONE
  * transaction on a dedicated connection.
  */
 async operationDecision(user:AuthenticatedUser,purchaseId:string,requestId:string,reason:string){
  this.authorize(user);this.requireFreshMfa(user);
  if(!this.settleOperations)fail("REFUND_DECISION_UNAVAILABLE");
  const parsed=refundReason.safeParse(reason);if(!parsed.success)fail("REFUND_DECISION_INVALID");reason=parsed.data;
  // One transaction: the locked decision statement, the refund request and the read
  // either all commit or none does.
  const client=await this.pool.connect();let broken:Error|undefined,conflict:unknown;
  try{
   await client.query("begin isolation level read committed");
   const outcome=await this.decideOperation(client,user,purchaseId,requestId,reason);
   await client.query("commit");
   return outcome;
  }catch(error){
   try{await client.query("rollback");}catch(rollbackError){broken=rollbackError instanceof Error?rollbackError:new Error("ROLLBACK_FAILED");}
   if(error instanceof ManualRefundError)throw error;
   const constraint=error && typeof error==="object" && "constraint" in error?String((error as {constraint:unknown}).constraint):"";
   const message=error instanceof Error?error.message:"";
   if(constraint==="peragus_purchase_one_open_per_customer" || message.includes("peragus_purchase_one_open_per_customer"))fail("REFUND_CUSTOMER_HAS_OPEN_OPERATION");
   if(message.includes("OPERATION_INVALID_TRANSITION"))fail("REFUND_PAYMENT_NOT_CONFIRMED");
   // A concurrent identical request inserted first: answer as a replay below.
   if(!(constraint.includes("operator_user_id") || message.includes("operator_user_id_request_id")))throw error;
   conflict=error;
  }finally{client.release(broken);}
  const again=await this.pool.query<{purchase_id:string;reason:string}>("select purchase_id,reason from peragus_operator_refund_decisions where operator_user_id=$1 and request_id=$2",[user.id,requestId]);
  if(!again.rows[0])throw conflict;
  if(again.rows[0].purchase_id!==purchaseId || again.rows[0].reason!==reason)fail("REFUND_IDEMPOTENCY_CONFLICT");
  return this.decisionResult(this.pool,purchaseId,true);
 }
 private async decideOperation(q:Pick<Pool,"query">,user:AuthenticatedUser,purchaseId:string,requestId:string,reason:string){
  type Result={inserted:number;prior_purchase:string|null;prior_reason:string|null;status:string|null;customer_id:string|null;paid:boolean|null;withdrawal:boolean|null};
  const r=(await q.query<Result>(`with prior as (
     select purchase_id,reason from peragus_operator_refund_decisions where operator_user_id=$2 and request_id=$3
    ), p as (
     select pi.id,pi.customer_id,pi.status from peragus_customer_purchase_intents pi
     where pi.id=$1 and pi.environment='${this.e.mode}' for update
    ), paid as (
     select exists(select 1 from peragus_customer_sandbox_pix x join p on x.purchase_intent_id=p.id and x.customer_id=p.customer_id
      where x.environment='${this.e.mode}' and x.observation->>'sourceLegStatus'='completed') as ok
    ), w as (
     -- Ruling 23: never a refund decision once a withdrawal approval or execution exists.
     select exists(select 1 from peragus_customer_withdrawal_requests wr join p on wr.purchase_intent_id=p.id and wr.customer_id=p.customer_id
      where exists(select 1 from peragus_withdrawal_operator_approvals a where a.withdrawal_request_id=wr.id)
       or exists(select 1 from peragus_sandbox_withdrawal_executions e where e.withdrawal_request_id=wr.id)) as busy
    ), d as (
     insert into peragus_operator_refund_decisions(id,purchase_id,customer_id,operator_user_id,request_id,reason,from_status,environment)
     select $4,p.id,p.customer_id,$2,$3,$5,p.status,'${this.e.mode}' from p,paid,w
     where not exists(select 1 from prior) and paid.ok and not w.busy
      and p.status in ('needs_review','pix_confirmed','converted','awaiting_approval','expired','failed')
      and not exists(select 1 from peragus_customers where owner_user_id=$2)
     returning purchase_id,customer_id,from_status
    ), u as (
     update peragus_customer_purchase_intents set status='refund_pending' where id in (select purchase_id from d) returning id,customer_id
    ), ev as (
     insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
     select u.id,u.customer_id,d.from_status,'refund_pending',$6,left('OPERATOR_REFUND_DECISION: '||$5,500),'${this.e.mode}'
     from u join d on d.purchase_id=u.id
    ) select (select count(*) from d)::int as inserted,(select purchase_id from prior) as prior_purchase,(select reason from prior) as prior_reason,
      (select status from p) as status,(select customer_id from p) as customer_id,(select ok from paid) as paid,(select busy from w) as withdrawal`,
   [purchaseId,user.id,requestId,randomUUID(),reason,`operator:${user.id}`])).rows[0]!;
  if(r.prior_purchase){
   if(r.prior_purchase!==purchaseId || r.prior_reason!==reason)fail("REFUND_IDEMPOTENCY_CONFLICT");
   return this.decisionResult(q,purchaseId,true);
  }
  if(r.inserted!==1){
   if(!r.status)fail("REFUND_OPERATION_NOT_FOUND");
   // `status` is the locked (latest) row: an approval committed while waiting shows as approved.
   if(r.withdrawal || ["approved","sending","sent","delivered_verified"].includes(r.status))fail("REFUND_WITHDRAWAL_IN_PROGRESS");
   if(r.status==="refund_pending")fail("REFUND_ALREADY_PENDING");
   if(!r.paid)fail("REFUND_PAYMENT_NOT_CONFIRMED");
   fail(["needs_review","pix_confirmed","converted","awaiting_approval","expired","failed"].includes(r.status)?"OPERATOR_ACCOUNT_SEPARATION_REQUIRED":"REFUND_DECISION_NOT_ALLOWED");
  }
  return this.decisionResult(q,purchaseId,false);
 }
 /** Creates (or reuses) the manual refund request of a refund_pending operation and renders the decision. */
 private async decisionResult(q:Pick<Pool,"query">,purchaseId:string,replayed:boolean){
  const owner=await q.query<{customer_id:string}>(`select customer_id from peragus_customer_purchase_intents where id=$1 and environment='${this.e.mode}'`,[purchaseId]);
  const customerId=owner.rows[0]!.customer_id;
  try{await this.record(customerId,purchaseId,systemRequestId(`system-refund-${purchaseId}`),SYSTEM_REFUND_REASON,q);}
  catch(error){if(!(error instanceof ManualRefundError && error.code==="REFUND_ALREADY_REQUESTED"))throw error;}
  const row=(await this.one("r.customer_id=$1 and r.purchase_intent_id=$2",[customerId,purchaseId],q))!;
  return {data:{purchase_intent_id:purchaseId,status:"refund_pending" as const,refund_request:view(row,this.e,true)},replayed};
 }
 private async record(customerId:string,purchaseId:string,requestId:string,reason:string,q:Pick<Pool,"query">=this.pool){
  const prior=await this.one("r.customer_id=$1 and r.request_id=$2",[customerId,requestId],q);
  if(prior){if(prior.purchase_intent_id!==purchaseId || prior.reason!==reason)fail("REFUND_IDEMPOTENCY_CONFLICT");return {data:view(prior,this.e),replayed:true};}
  const inserted=await q.query(`insert into peragus_customer_refund_requests(id,customer_id,purchase_intent_id,pix_id,request_id,reason,amount_brl,environment)
   select $1,p.customer_id,p.id,x.id,$4,$5,x.source_amount_brl,'${this.e.mode}'
   from peragus_customer_purchase_intents p join peragus_customer_sandbox_pix x on x.purchase_intent_id=p.id and x.customer_id=p.customer_id
   join peragus_customers customer on customer.id=p.customer_id and customer.customer_type='pf' and not customer.suspended
   where p.id=$3 and p.customer_id=$2 and p.environment='${this.e.mode}' and x.environment='${this.e.mode}'
    and x.create_attempted and x.provider_transfer_id is not null
    and x.provider_customer_id=p.provider_customer_id and x.wallet_address=p.wallet_address
    and x.observation->'source'->>'type'='fiat_payment' and x.observation->'source'->>'currency'='BRL'
    and x.observation->'source'->>'rail'='pix' and x.observation->>'quoteId'=x.provider_quote_id
    and x.observation->>'id'=x.provider_transfer_id and x.observation->>'customerId'=x.provider_customer_id
    and x.observation->>'sourceLegStatus'='completed'
    and x.observation->'amounts'->'source'->>'currency'='BRL'
    and x.source_amount_brl=p.source_amount_brl
    and case when x.observation->'amounts'->'source'->>'amount' ~ '^[0-9]{1,15}([.][0-9]{1,2})?$'
     then (x.observation->'amounts'->'source'->>'amount')::numeric=x.source_amount_brl else false end
   on conflict do nothing returning id`,[randomUUID(),customerId,purchaseId,requestId,reason]);
  const row=await this.one("r.customer_id=$1 and r.request_id=$2",[customerId,requestId],q);
  if(row){if(row.purchase_intent_id!==purchaseId || row.reason!==reason)fail("REFUND_IDEMPOTENCY_CONFLICT");return {data:view(row,this.e),replayed:inserted.rows.length===0};}
  const owned=await q.query(`select id from peragus_customer_purchase_intents where id=$1 and customer_id=$2 and environment='${this.e.mode}'`,[purchaseId,customerId]);
  if(!owned.rows[0])fail("REFUND_OPERATION_NOT_FOUND");
  if(await this.one("r.customer_id=$1 and r.purchase_intent_id=$2",[customerId,purchaseId],q))fail("REFUND_ALREADY_REQUESTED");
  fail("REFUND_PAYMENT_NOT_CONFIRMED");
 }
 async operatorRead(user:AuthenticatedUser,id:string){this.authorize(user);const row=await this.one("r.id=$1",[id]);if(!row)fail("REFUND_REQUEST_NOT_FOUND");return view(row,this.e,true);}
 async list(user:AuthenticatedUser,query:unknown){
  this.authorize(user);
  const parsed=z.object({state:z.enum(["all","pending_review","approved","rejected","refund_recorded"]).optional(),limit:z.string().optional(),cursor:z.string().optional()}).strict().safeParse(query);
  if(!parsed.success)throw new OperationHistoryInputError();
  const {state:filter="pending_review",...page}=parsed.data,{limit,cursor}=parseHistoryQuery(page);
  const r=await this.pool.query<Row>(`${select} where r.environment='${this.e.mode}'
   and ($1='all' or case when c.id is not null then 'refund_recorded' else coalesce(d.decision,'pending_review') end=$1)
   and ($2::timestamptz is null or (r.created_at,r.id)<($2::timestamptz,$3::uuid))
   order by r.created_at desc,r.id desc limit $4`,[filter,cursor?.created_at??null,cursor?.id??null,limit+1]);
  const rows=r.rows.slice(0,limit),last=rows.at(-1),more=r.rows.length>limit;
  return {data:rows.map(row=>view(row,this.e,true)),meta:{state:filter,has_more:more,next_cursor:more&&last?Buffer.from(JSON.stringify({created_at:last.cursor_time,id:last.id})).toString("base64url"):null}};
 }
 async decide(user:AuthenticatedUser,id:string,requestId:string,decision:"approved"|"rejected",reason:string){
  this.authorize(user);this.writable();
  const prior=await this.pool.query<{refund_request_id:string}>("select refund_request_id from peragus_manual_refund_decisions where operator_user_id=$1 and request_id=$2",[user.id,requestId]);
  if(prior.rows[0] && prior.rows[0].refund_request_id!==id)fail("REFUND_IDEMPOTENCY_CONFLICT");
  const before=await this.one("r.id=$1",[id]);if(!before)fail("REFUND_REQUEST_NOT_FOUND");
  const inserted=await this.pool.query(`insert into peragus_manual_refund_decisions(id,refund_request_id,customer_id,operator_user_id,request_id,decision,reason)
   select $1,r.id,r.customer_id,$3,$4,$5,$6 from peragus_customer_refund_requests r where r.id=$2
    and not exists(select 1 from peragus_customers where owner_user_id=$3) on conflict do nothing returning id`,[randomUUID(),id,user.id,requestId,decision,reason]);
  const row=(await this.one("r.id=$1",[id]))!;
  if(row.decision_operator===user.id && row.decision_request_id===requestId){if(row.decision!==decision || row.decision_reason!==reason)fail("REFUND_IDEMPOTENCY_CONFLICT");return {data:view(row,this.e,true),replayed:inserted.rows.length===0};}
  fail(row.decision_id?"REFUND_ALREADY_DECIDED":"REFUND_IDEMPOTENCY_CONFLICT");
 }
 async complete(user:AuthenticatedUser,id:string,requestId:string,amount:string,reference:string){
  this.authorize(user);this.requireFreshMfa(user);this.writable();amount=normalized(amount);
  const prior=await this.pool.query<{refund_request_id:string}>("select refund_request_id from peragus_manual_refund_completions where operator_user_id=$1 and request_id=$2",[user.id,requestId]);
  if(prior.rows[0] && prior.rows[0].refund_request_id!==id)fail("REFUND_IDEMPOTENCY_CONFLICT");
  const before=await this.one("r.id=$1",[id]);if(!before)fail("REFUND_REQUEST_NOT_FOUND");
  if(cents(amount)>cents(before.amount_brl))fail("REFUND_AMOUNT_EXCEEDS_PAYMENT");
  // With settleOperations the completion, the refund_pending -> refunded move and its status
  // event are ONE statement (atomic); a completion is only recorded for a refund_pending operation.
  const settle=this.settleOperations;
  const inserted=await this.pool.query(`with p as (
    select pi.id,pi.customer_id,pi.status from peragus_customer_purchase_intents pi
    join peragus_customer_refund_requests rr on rr.purchase_intent_id=pi.id and rr.customer_id=pi.customer_id
    where rr.id=$2 and pi.environment='${this.e.mode}' for update of pi
   ), c as (
    insert into peragus_manual_refund_completions(id,refund_request_id,customer_id,decision_id,operator_user_id,request_id,maximum_amount_brl,amount_brl,reference)
    select $1,r.id,r.customer_id,d.id,$3,$4,r.amount_brl,$5,$6 from peragus_customer_refund_requests r
    join peragus_manual_refund_decisions d on d.refund_request_id=r.id and d.customer_id=r.customer_id and d.decision='approved'
    where r.id=$2 and not exists(select 1 from peragus_customers where owner_user_id=$3)
     ${settle?"and exists(select 1 from p where p.status='refund_pending')":""}
    on conflict do nothing returning id
   ), u as (
    update peragus_customer_purchase_intents set status='refunded'
    where ${settle?"id in (select id from p) and exists(select 1 from c)":"false"} returning id,customer_id
   ), ev as (
    insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
    select id,customer_id,'refund_pending','refunded',$7,'manual_refund_recorded','${this.e.mode}' from u
   ) select id from c`,[randomUUID(),id,user.id,requestId,amount,reference,`operator:${user.id}`]);
  const row=(await this.one("r.id=$1",[id]))!;
  if(row.completion_operator===user.id && row.completion_request_id===requestId){if(row.returned_amount!==amount || row.reference!==reference)fail("REFUND_IDEMPOTENCY_CONFLICT");
   return {data:view(row,this.e,true),replayed:inserted.rows.length===0};}
  if(settle && !row.completion_id && row.decision==="approved"){
   const op=await this.pool.query<{status:string}>(`select status from peragus_customer_purchase_intents where id=$1 and environment='${this.e.mode}'`,[row.purchase_intent_id]);
   if(op.rows[0]?.status!=="refund_pending")fail("REFUND_OPERATION_NOT_REFUND_PENDING");
  }
  fail(row.completion_id?"REFUND_ALREADY_RECORDED":row.decision!=="approved"?"REFUND_APPROVAL_REQUIRED":"REFUND_IDEMPOTENCY_CONFLICT");
 }
}
