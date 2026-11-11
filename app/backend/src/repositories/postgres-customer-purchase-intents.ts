import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import {PurchaseIntentError,type OperationTransition,type PurchaseIntent,type PurchaseIntentRepository} from "../purchases/customer-purchase-intents.js";
import {canTransition,isOperationStatus,TERMINAL_STATUSES,type OperationStatus,type PurchaseLimits} from "../purchases/operation-status.js";
interface Row {id:string;customer_id:string;request_id:string;quote_id:string;source_amount_brl:string;
 estimated_target_amount_usdt:string;quote_snapshot:PurchaseIntent["quoteSnapshot"];wallet_address:string;wallet_verified_at:Date|string;created_at:Date|string;
 status:OperationStatus;status_changed_at:Date|string;}
const map=(r:Row):PurchaseIntent=>({id:r.id,customerId:r.customer_id,requestId:r.request_id,quoteId:r.quote_id,sourceAmountBrl:r.source_amount_brl,
 estimatedTargetAmountUsdt:r.estimated_target_amount_usdt,quoteSnapshot:r.quote_snapshot,walletAddress:r.wallet_address,
 walletVerifiedAt:new Date(r.wallet_verified_at).toISOString(),createdAt:new Date(r.created_at).toISOString(),
 status:r.status,statusChangedAt:new Date(r.status_changed_at).toISOString()});
export interface PurchaseIntentRepositoryOptions {
 /** PURCHASE_MAX_OPEN_GLOBAL: open operations allowed at once in this environment. */
 maxOpenGlobal:number;
 /** PURCHASE_MIN_BRL/PURCHASE_MAX_BRL in cents; checked again when the quote is accepted. */
 limits:PurchaseLimits;
}
// Serializes accepts so the global open-operation count cannot race.
const ACCEPT_LOCK="select pg_advisory_xact_lock(808613,45)";
const OPEN=`status not in (${[...TERMINAL_STATUSES].map(s=>`'${s}'`).join(",")})`;
export class PostgresCustomerPurchaseIntentRepository implements PurchaseIntentRepository {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pool,mode:MoneyMode,private readonly options:PurchaseIntentRepositoryOptions){
  this.e=rowEnvironment(mode);
  if(!Number.isInteger(options.maxOpenGlobal) || options.maxOpenGlobal<1)throw new Error("PURCHASE_MAX_OPEN_GLOBAL_INVALID");
  if(options.limits.minCents<=0n || options.limits.minCents>options.limits.maxCents)throw new Error("PURCHASE_LIMITS_INVALID");
 }
 async read(customerId:string,id:string){const r=await this.pool.query<Row>(`select * from peragus_customer_purchase_intents where customer_id=$1 and id=$2 and environment='${this.e.mode}'`,[customerId,id]);return r.rows[0]?map(r.rows[0]):null;}
 private async findRequest(db:Pick<Pool,"query">,customerId:string,requestId:string){const r=await db.query<Row>(`select * from peragus_customer_purchase_intents where customer_id=$1 and request_id=$2 and environment='${this.e.mode}'`,[customerId,requestId]);return r.rows[0]?map(r.rows[0]):null;}
 private replay(record:PurchaseIntent,quoteId:string){if(record.quoteId!==quoteId)throw new PurchaseIntentError("PURCHASE_IDEMPOTENCY_CONFLICT");return{record,replayed:true};}
 // Prerequisite reads shared by the insert and its failure diagnosis.
 // $2 customer, $4 quote; no caller-supplied amount, address, provider ID or approval can enter it.
 private prerequisites(customer="$2",quote="$4"){return `from peragus_customer_indicative_quotes q
   join peragus_customers c on c.id=q.customer_id and c.customer_type='pf' and not c.suspended
   join peragus_customer_onboarding_submissions s on s.customer_id=q.customer_id and s.environment='${this.e.mode}'
   join peragus_customer_terms_sessions t on t.id=s.terms_session_id and t.customer_id=q.customer_id and t.environment=s.environment
   join peragus_customer_verifications v on v.customer_id=q.customer_id and v.environment=s.environment
   join peragus_customer_screenings sc on sc.customer_id=q.customer_id and sc.environment=s.environment
   join peragus_customer_wallets w on w.customer_id=q.customer_id and w.environment=s.environment and w.network='${this.e.network}'
   where q.id=${quote} and q.customer_id=${customer} and q.environment=s.environment and q.provider_quote_id is not null
    and q.create_attempted and q.observation->>'customerId'=q.provider_customer_id
    and q.observation->>'id'=q.provider_quote_id and (q.observation->>'rate')::numeric>0
    and q.observation->>'rateType'='floating' and q.observation->'expiresAt'='null'::jsonb
    and q.observation->>'spreadBps'='0' and q.observation->'source'->>'currency'='BRL'
    and (q.observation->'source'->>'amount')::numeric=q.source_amount_brl
    and q.observation->'target'->>'currency'='USDT' and (q.observation->'target'->>'amount')::numeric>0
    and s.state='linked' and s.provider_customer_id=q.provider_customer_id and s.provider_status='approved'
    and s.verification_mode='full' and s.provider_snapshot->>'requirements_pending'='false'
    and t.state='accepted' and t.accepted_at is not null
    and v.provider_customer_id=q.provider_customer_id and v.verification_id is not null
    and v.observation->>'status'='completed' and v.observation->'checks'->>'kyc_document'='pass'
    and v.observation->'checks'->>'liveness'='pass' and v.observation->'checks'->>'face_match'='pass'
    and coalesce(v.observation->'checks'->>'aml_name_screening','not_started') in ('not_started','pass')
    and sc.provider_customer_id=q.provider_customer_id and sc.screening_id is not null
    and sc.observation->>'status'='completed' and sc.observation->>'result'='clear'
    and sc.observation->>'matchesCount'='0' and sc.observation->>'suggestedDecision'='clear'
    and sc.observation->'lists' @> '["sanctions","pep"]'::jsonb`;}
 async record(customerId:string,requestId:string,quoteId:string){
  const prior=await this.findRequest(this.pool,customerId,requestId);if(prior)return this.replay(prior,quoteId);
  try{return await this.inTransaction("begin isolation level read committed",async client=>{
   await client.query(ACCEPT_LOCK);
   const params=[randomUUID(),customerId,requestId,quoteId,this.options.limits.minCents.toString(),this.options.limits.maxCents.toString()];
   // Derivation, prerequisite reads, range check and insert use ONE SQL statement.
   const r=await client.query<Row>(`insert into peragus_customer_purchase_intents(
    id,customer_id,request_id,quote_id,provider_customer_id,source_amount_brl,estimated_target_amount_usdt,
    quote_snapshot,wallet_address,wallet_verified_at,evidence_snapshot,environment,wallet_proof_network)
   select $1::uuid,q.customer_id,$3::uuid,q.id,q.provider_customer_id,q.source_amount_brl,(q.observation->'target'->>'amount')::numeric,
    jsonb_build_object('rate',q.observation->>'rate','rate_type',q.observation->>'rateType','quoted_at',q.observation->>'createdAt',
     'exchange_conditions',jsonb_build_object('spread_bps',q.observation->'spreadBps','rate_without_spread',q.observation->'rateWithoutSpread','amount_deducted',q.observation->'amountDeducted')),
    w.wallet_address,w.verified_at,jsonb_build_object('registration_snapshot_version',s.snapshot_version,
     'verification_revision',v.revision,'screening_revision',sc.revision,'terms_session_id',t.id,'wallet_proof_id',w.proof_challenge_id),
    '${this.e.mode}','${this.e.network}'
   ${this.prerequisites()}
    and q.source_amount_brl*100 between $5::bigint and $6::bigint
   on conflict do nothing returning *`,params);
   const row=r.rows[0];
   if(!row)throw await this.diagnose(client,params);
   await client.query(`insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
    values($1,$2,null,'accepted',$3,'quote_accepted','${this.e.mode}')`,[row.id,row.customer_id,`customer:${customerId}`]);
   const open=await client.query<{n:number}>(`select count(*)::int n from peragus_customer_purchase_intents where environment='${this.e.mode}' and ${OPEN}`);
   if(Number(open.rows[0]!.n)>this.options.maxOpenGlobal)throw new PurchaseIntentError("PURCHASE_GLOBAL_CAPACITY_REACHED");
   return{record:map(row),replayed:false};
  });}catch(error){
   if(error instanceof Replay)return this.replay(error.record,quoteId);
   throw error;
  }
 }
 /**
  * Runs work in one transaction. A failed rollback keeps the original error and
  * releases the connection as broken so the pool discards it.
  */
 private async inTransaction<T>(begin:string,work:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect();let broken:Error|undefined;
  try{
   await client.query(begin);
   const result=await work(client);
   await client.query("commit");
   return result;
  }catch(error){
   try{await client.query("rollback");}catch(rollbackError){broken=rollbackError instanceof Error?rollbackError:new Error("ROLLBACK_FAILED");}
   throw error;
  }finally{client.release(broken);}
 }
 // Explains an insert that wrote nothing, in order of precedence.
 private async diagnose(client:PoolClient,params:string[]):Promise<Error>{
  const [,customerId,requestId,quoteId]=params as [string,string,string,string];
  // A competing call recorded the same request first: replay it instead.
  const raced=await this.findRequest(client,customerId,requestId);if(raced)return new Replay(raced);
  const quote=await client.query<{in_range:boolean}>(`select source_amount_brl*100 between $3::bigint and $4::bigint in_range from peragus_customer_indicative_quotes where customer_id=$1 and id=$2 and environment='${this.e.mode}'`,[customerId,quoteId,params[4],params[5]]);
  if(!quote.rows[0])return new PurchaseIntentError("PURCHASE_QUOTE_NOT_FOUND");
  const used=await client.query(`select id from peragus_customer_purchase_intents where customer_id=$1 and quote_id=$2 and environment='${this.e.mode}'`,[customerId,quoteId]);
  if(used.rows[0])return new PurchaseIntentError("PURCHASE_QUOTE_ALREADY_RECORDED");
  const ready=await client.query<{ok:boolean}>(`select exists(select 1 ${this.prerequisites("$1","$2")}) ok`,[customerId,quoteId]);
  if(!ready.rows[0]?.ok)return new PurchaseIntentError("PURCHASE_PREREQUISITES_NOT_RECORDED");
  if(!quote.rows[0].in_range)return new PurchaseIntentError("QUOTE_AMOUNT_OUT_OF_RANGE");
  // Any environment: the one-open-operation index is per customer, not per environment.
  const open=await client.query(`select id from peragus_customer_purchase_intents where customer_id=$1 and ${OPEN}`,[customerId]);
  if(open.rows[0])return new PurchaseIntentError("PURCHASE_CUSTOMER_HAS_OPEN_OPERATION");
  return new PurchaseIntentError("PURCHASE_PREREQUISITES_NOT_RECORDED");
 }
 /**
  * Moves a purchase to `to` and appends one peragus_operation_status_events row,
  * atomically. Re-applying the current status is a no-op (changed:false, no event).
  * The database trigger re-validates the transition.
  */
 async transitionOperation(purchaseId:string,to:OperationStatus,actor:string,reason:string):Promise<OperationTransition>{
  if(!isOperationStatus(to))throw new PurchaseIntentError("OPERATION_INVALID_TRANSITION");
  if(typeof actor!=="string" || actor.length<1 || actor.length>200 || typeof reason!=="string" || reason.length<1 || reason.length>500)
   throw new Error("OPERATION_TRANSITION_INPUT_INVALID");
  try{return await this.inTransaction("begin isolation level read committed",async client=>{
   const current=await client.query<{status:OperationStatus;customer_id:string;status_changed_at:Date|string}>(
    `select status,customer_id,status_changed_at from peragus_customer_purchase_intents where id=$1 and environment='${this.e.mode}' for update`,[purchaseId]);
   const row=current.rows[0];
   if(!row)throw new PurchaseIntentError("PURCHASE_INTENT_NOT_FOUND");
   if(row.status===to)return{from:to,to,changed:false,changedAt:new Date(row.status_changed_at).toISOString()};
   if(!canTransition(row.status,to))throw new PurchaseIntentError("OPERATION_INVALID_TRANSITION");
   const updated=await client.query<{status_changed_at:Date|string}>(
    `update peragus_customer_purchase_intents set status=$2 where id=$1 and environment='${this.e.mode}' returning status_changed_at`,[purchaseId,to]);
   await client.query(`insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
    values($1,$2,$3,$4,$5,$6,'${this.e.mode}')`,[purchaseId,row.customer_id,row.status,to,actor,reason]);
   return{from:row.status,to,changed:true,changedAt:new Date(updated.rows[0]!.status_changed_at).toISOString()};
  });}catch(error){
   if(error instanceof Error && !(error instanceof PurchaseIntentError) && error.message.includes("OPERATION_INVALID_TRANSITION"))
    throw new PurchaseIntentError("OPERATION_INVALID_TRANSITION");
   throw error;
  }
 }
}
class Replay extends Error{constructor(readonly record:PurchaseIntent){super("PURCHASE_REPLAY");}}
