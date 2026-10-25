import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {z} from "zod";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {authorizeWithdrawalOperator} from "../withdrawals/operator-approvals.js";
import {OperationHistoryInputError,parseHistoryQuery} from "../purchases/customer-operation-history.js";

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
function view(r:Row,operator=false){return {
 id:r.id,purchase_intent_id:r.purchase_intent_id,pix_id:r.pix_id,request_id:r.request_id,state:state(r),reason:r.reason,
 requested_amount:{currency:"BRL",amount:r.amount_brl},created_at:iso(r.created_at),decision_recorded_at:iso(r.decision_at),
 returned_amount:r.returned_amount?{currency:"BRL",amount:r.returned_amount}:null,
 partial_refund:r.returned_amount?cents(r.returned_amount)<cents(r.amount_brl):null,
 refund_recorded_at:iso(r.completion_at),environment:"test",record_only:true,refund_execution_automated:false,
 provider_verified:false,original_transfer_cancelled:false,
 ...(operator?{customer_id:r.customer_id,decision:r.decision_id?{id:r.decision_id,operator_user_id:r.decision_operator,reason:r.decision_reason}:null,
 completion:r.completion_id?{id:r.completion_id,operator_user_id:r.completion_operator,reference:r.reference}:null,
 withdrawal_context:{started:r.withdrawal_attempted===true,provider_state:r.withdrawal_state,requires_manual_funds_review:r.withdrawal_attempted===true}}:{})
};}

/** All writes are local append-only evidence; this class has no provider/queue/signer. */
export class ManualRefundService {
 constructor(private readonly pool:Pick<Pool,"query">,private readonly operators:ReadonlySet<string>,private readonly enabled=false){}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.operators);}
 private writable(){if(!this.enabled)fail("MANUAL_REFUNDS_DISABLED");}
 private async one(where:string,args:unknown[]){const r=await this.pool.query<Row>(`${select} where r.environment='test' and ${where}`,args);return r.rows[0]??null;}
 async customerRead(customerId:string,purchaseId:string){
  const row=await this.one("r.customer_id=$1 and r.purchase_intent_id=$2",[customerId,purchaseId]);
  if(!row)fail("REFUND_REQUEST_NOT_FOUND");return view(row);
 }
 async request(customerId:string,purchaseId:string,requestId:string,reason:string){
  this.writable();
  const prior=await this.one("r.customer_id=$1 and r.request_id=$2",[customerId,requestId]);
  if(prior){if(prior.purchase_intent_id!==purchaseId || prior.reason!==reason)fail("REFUND_IDEMPOTENCY_CONFLICT");return {data:view(prior),replayed:true};}
  const inserted=await this.pool.query(`insert into peragus_customer_refund_requests(id,customer_id,purchase_intent_id,pix_id,request_id,reason,amount_brl)
   select $1,p.customer_id,p.id,x.id,$4,$5,x.source_amount_brl
   from peragus_customer_purchase_intents p join peragus_customer_sandbox_pix x on x.purchase_intent_id=p.id and x.customer_id=p.customer_id
   join peragus_customers customer on customer.id=p.customer_id and customer.customer_type='pf' and not customer.suspended
   where p.id=$3 and p.customer_id=$2 and p.environment='test' and x.environment='test'
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
  const row=await this.one("r.customer_id=$1 and r.request_id=$2",[customerId,requestId]);
  if(row){if(row.purchase_intent_id!==purchaseId || row.reason!==reason)fail("REFUND_IDEMPOTENCY_CONFLICT");return {data:view(row),replayed:inserted.rows.length===0};}
  const owned=await this.pool.query("select id from peragus_customer_purchase_intents where id=$1 and customer_id=$2 and environment='test'",[purchaseId,customerId]);
  if(!owned.rows[0])fail("REFUND_OPERATION_NOT_FOUND");
  if(await this.one("r.customer_id=$1 and r.purchase_intent_id=$2",[customerId,purchaseId]))fail("REFUND_ALREADY_REQUESTED");
  fail("REFUND_PAYMENT_NOT_CONFIRMED");
 }
 async operatorRead(user:AuthenticatedUser,id:string){this.authorize(user);const row=await this.one("r.id=$1",[id]);if(!row)fail("REFUND_REQUEST_NOT_FOUND");return view(row,true);}
 async list(user:AuthenticatedUser,query:unknown){
  this.authorize(user);
  const parsed=z.object({state:z.enum(["all","pending_review","approved","rejected","refund_recorded"]).optional(),limit:z.string().optional(),cursor:z.string().optional()}).strict().safeParse(query);
  if(!parsed.success)throw new OperationHistoryInputError();
  const {state:filter="pending_review",...page}=parsed.data,{limit,cursor}=parseHistoryQuery(page);
  const r=await this.pool.query<Row>(`${select} where r.environment='test'
   and ($1='all' or case when c.id is not null then 'refund_recorded' else coalesce(d.decision,'pending_review') end=$1)
   and ($2::timestamptz is null or (r.created_at,r.id)<($2::timestamptz,$3::uuid))
   order by r.created_at desc,r.id desc limit $4`,[filter,cursor?.created_at??null,cursor?.id??null,limit+1]);
  const rows=r.rows.slice(0,limit),last=rows.at(-1),more=r.rows.length>limit;
  return {data:rows.map(row=>view(row,true)),meta:{state:filter,has_more:more,next_cursor:more&&last?Buffer.from(JSON.stringify({created_at:last.cursor_time,id:last.id})).toString("base64url"):null}};
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
  if(row.decision_operator===user.id && row.decision_request_id===requestId){if(row.decision!==decision || row.decision_reason!==reason)fail("REFUND_IDEMPOTENCY_CONFLICT");return {data:view(row,true),replayed:inserted.rows.length===0};}
  fail(row.decision_id?"REFUND_ALREADY_DECIDED":"REFUND_IDEMPOTENCY_CONFLICT");
 }
 async complete(user:AuthenticatedUser,id:string,requestId:string,amount:string,reference:string){
  this.authorize(user);this.writable();amount=normalized(amount);
  const prior=await this.pool.query<{refund_request_id:string}>("select refund_request_id from peragus_manual_refund_completions where operator_user_id=$1 and request_id=$2",[user.id,requestId]);
  if(prior.rows[0] && prior.rows[0].refund_request_id!==id)fail("REFUND_IDEMPOTENCY_CONFLICT");
  const before=await this.one("r.id=$1",[id]);if(!before)fail("REFUND_REQUEST_NOT_FOUND");
  if(cents(amount)>cents(before.amount_brl))fail("REFUND_AMOUNT_EXCEEDS_PAYMENT");
  const inserted=await this.pool.query(`insert into peragus_manual_refund_completions(id,refund_request_id,customer_id,decision_id,operator_user_id,request_id,maximum_amount_brl,amount_brl,reference)
   select $1,r.id,r.customer_id,d.id,$3,$4,r.amount_brl,$5,$6 from peragus_customer_refund_requests r
   join peragus_manual_refund_decisions d on d.refund_request_id=r.id and d.customer_id=r.customer_id and d.decision='approved'
   where r.id=$2 and not exists(select 1 from peragus_customers where owner_user_id=$3) on conflict do nothing returning id`,[randomUUID(),id,user.id,requestId,amount,reference]);
  const row=(await this.one("r.id=$1",[id]))!;
  if(row.completion_operator===user.id && row.completion_request_id===requestId){if(row.returned_amount!==amount || row.reference!==reference)fail("REFUND_IDEMPOTENCY_CONFLICT");return {data:view(row,true),replayed:inserted.rows.length===0};}
  fail(row.completion_id?"REFUND_ALREADY_RECORDED":row.decision!=="approved"?"REFUND_APPROVAL_REQUIRED":"REFUND_IDEMPOTENCY_CONFLICT");
 }
}
