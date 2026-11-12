import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import {transitionOperationInTransaction} from "./postgres-customer-purchase-intents.js";
import type {OperationStatus} from "../purchases/operation-status.js";
import {SandboxExecutionError,validateWithdrawal,type ExecutionClaim,type ExecutionContext,type SandboxExecution,type SandboxExecutionRepository} from "../withdrawals/sandbox-execution.js";
import type {WithdrawalObservation} from "../providers/ozav-sandbox-withdrawal.js";
const eligible=(env:RowEnvironment)=>`select r.id as withdrawal_request_id,r.customer_id,a.id as approval_id,a.operator_user_id as approver_id,x.id as pix_id,
 x.provider_customer_id,x.provider_wallet_id,x.provider_quote_id,x.provider_transfer_id as funding_transfer_id,
 x.source_amount_brl as amount_brl,r.amount_usdt,r.wallet_address,r.wallet_verified_at as verified_at,a.created_at as approved_at,
 p.id as purchase_id,p.status as operation_status,p.locked_usdt_amount as send_amount_usdt,
 -- Measured against the database clock (the same clock that wrote created_at).
 extract(epoch from (now()-a.created_at))::float8 as approval_age_seconds
   from peragus_customer_withdrawal_requests r join peragus_withdrawal_operator_approvals a on a.withdrawal_request_id=r.id and a.customer_id=r.customer_id and a.amount_usdt=r.amount_usdt and a.wallet_address=r.wallet_address and a.environment='${env.mode}' and a.assurance_level='aal2' join peragus_customer_sandbox_pix x on x.id=r.pix_id and x.customer_id=r.customer_id and x.purchase_intent_id=r.purchase_intent_id join peragus_customer_purchase_intents p on p.id=x.purchase_intent_id and p.customer_id=x.customer_id join peragus_customer_indicative_quotes q on q.id=p.quote_id and q.customer_id=p.customer_id
   join peragus_customers c on c.id=q.customer_id and c.customer_type='pf' and not c.suspended
   join peragus_customer_onboarding_submissions s on s.customer_id=q.customer_id and s.environment='${env.mode}'
   join peragus_customer_terms_sessions t on t.id=s.terms_session_id and t.customer_id=q.customer_id and t.environment='${env.mode}'
   join peragus_customer_verifications v on v.customer_id=q.customer_id and v.environment='${env.mode}'
   join peragus_customer_screenings sc on sc.customer_id=q.customer_id and sc.environment='${env.mode}'
   join peragus_customer_wallets w on w.customer_id=q.customer_id and w.environment='${env.mode}' and w.network='${env.network}'
   where r.id=$1 and q.environment='${env.mode}' and q.provider_quote_id is not null
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
    and sc.observation->'lists' @> '["sanctions","pep"]'::jsonb
 and p.source_amount_brl=q.source_amount_brl and p.wallet_address=w.wallet_address and p.provider_customer_id=q.provider_customer_id
 and x.environment='${env.mode}' and p.environment='${env.mode}' and x.create_attempted and x.provider_transfer_id is not null
 and x.provider_customer_id=p.provider_customer_id and x.provider_quote_id=q.provider_quote_id
 and x.source_amount_brl=p.source_amount_brl and x.wallet_address=p.wallet_address
 and x.observation->>'id'=x.provider_transfer_id and x.observation->>'customerId'=x.provider_customer_id
 and x.observation->>'quoteId'=x.provider_quote_id and x.observation->>'status'='completed'
 and x.observation->>'sourceLegStatus'='completed' and x.observation->>'destinationLegStatus'='completed'
 and x.observation->'source'->>'type'='fiat_payment' and x.observation->'source'->>'currency'='BRL'
 and x.observation->'source'->>'rail'='pix' and x.observation->'destination'->>'type'='wallet'
 and x.observation->'destination'->>'walletId'=x.provider_wallet_id
 and x.observation->'amounts'->'source'->>'currency'='BRL'
 and case when x.observation->'amounts'->'source'->>'amount' ~ '^[0-9]+([.][0-9]{1,2})?$'
  then (x.observation->'amounts'->'source'->>'amount')::numeric=x.source_amount_brl else false end
 and x.observation->'amounts'->'target'->>'currency'='USDT'
 and case when x.observation->'amounts'->'target'->>'amount' ~ '^[0-9]{1,15}([.][0-9]{1,6})?$'
  then (x.observation->'amounts'->'target'->>'amount')::numeric>0 else false end

 and r.environment='${env.mode}' and r.record_only and r.state='recorded'
 and r.provider_customer_id=x.provider_customer_id and r.provider_wallet_id=x.provider_wallet_id and r.provider_transfer_id=x.provider_transfer_id
 and r.wallet_address=p.wallet_address and r.wallet_address=w.wallet_address
 and r.amount_usdt=(x.observation->'amounts'->'target'->>'amount')::numeric

`;
interface ContextRow {withdrawal_request_id:string;customer_id:string;approval_id:string;approver_id:string;pix_id:string;purchase_id:string;
 provider_customer_id:string;provider_wallet_id:string;provider_quote_id:string;funding_transfer_id:string;amount_brl:string;amount_usdt:string;send_amount_usdt:string|null;wallet_address:string;verified_at:Date|string;approved_at?:Date|string|null;approval_age_seconds?:number|string|null;operation_status?:OperationStatus;}
interface Row extends ContextRow {id:string;operator_id:string;request_id:string;create_attempted:boolean;provider_send_id:string|null;observation:WithdrawalObservation|null;closed_at:Date|string|null;
 environment:MoneyMode;provider_tx_hash:string|null;provider_refusal_code:string|null;}
const contextMap=(r:ContextRow):ExecutionContext=>({withdrawalId:r.withdrawal_request_id,customerId:r.customer_id,approvalId:r.approval_id,approverId:r.approver_id,pixId:r.pix_id,purchaseId:r.purchase_id,
 providerCustomerId:r.provider_customer_id,providerWalletId:r.provider_wallet_id,providerQuoteId:r.provider_quote_id,transferId:r.funding_transfer_id,
 amountBrl:r.amount_brl,amountUsdt:r.amount_usdt,sendAmountUsdt:r.send_amount_usdt==null?null:String(r.send_amount_usdt),walletAddress:r.wallet_address,verifiedAt:new Date(r.verified_at).toISOString(),
 ...(r.approved_at?{approvedAt:new Date(r.approved_at).toISOString()}:{}),
 ...(r.approval_age_seconds!=null?{approvalAgeSeconds:Number(r.approval_age_seconds)}:{}),
 ...(r.operation_status?{operationStatus:r.operation_status}:{})});
const map=(r:Row):SandboxExecution=>({...contextMap(r),id:r.id,operatorId:r.operator_id,requestId:r.request_id,attempted:r.create_attempted,sendTransferId:r.provider_send_id,observation:r.observation,closedAt:r.closed_at?new Date(r.closed_at).toISOString():null,
 environment:r.environment,txHash:r.provider_tx_hash,refusalCode:r.provider_refusal_code});
const SEND_CLAIMED="WITHDRAWAL_SEND_CLAIMED",SEND_ACCEPTED="OZAV_SEND_ACCEPTED",SEND_REFUSED="WITHDRAWAL_SEND_REFUSED";
export class PostgresSandboxExecutionRepository implements SandboxExecutionRepository {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pool,mode:MoneyMode){this.e=rowEnvironment(mode);}
 async context(id:string){const r=await this.pool.query<ContextRow>(eligible(this.e),[id]);return r.rows[0]?contextMap(r.rows[0]):null;}
 async read(id:string){const r=await this.pool.query<Row>(`select e.*,r.purchase_intent_id as purchase_id from peragus_sandbox_withdrawal_executions e
  join peragus_customer_withdrawal_requests r on r.id=e.withdrawal_request_id and r.customer_id=e.customer_id
  where e.withdrawal_request_id=$1 and e.environment='${this.e.mode}'`,[id]);return r.rows[0]?map(r.rows[0]):null;}
 /**
  * Runs `work` in one READ COMMITTED transaction on a dedicated connection; commits only when
  * `work` says so. Lock order everywhere: purchase row first, then the execution row.
  */
 private async transaction<T>(work:(client:PoolClient)=>Promise<{commit:boolean;value:T}>):Promise<T>{
  const client=await this.pool.connect();let broken:Error|undefined;
  try{
   await client.query("begin isolation level read committed");
   const result=await work(client);
   await client.query(result.commit?"commit":"rollback");
   return result.value;
  }catch(error){
   try{await client.query("rollback");}catch(rollbackError){broken=rollbackError instanceof Error?rollbackError:new Error("ROLLBACK_FAILED");}
   throw error;
  }finally{client.release(broken);}
 }
 private async lockOperation(client:PoolClient,purchaseId:string){
  const r=await client.query<{status:OperationStatus}>(`select status from peragus_customer_purchase_intents where id=$1 and environment='${this.e.mode}' for update`,[purchaseId]);
  return r.rows[0]?.status??null;
 }
 async reserve(operatorId:string,requestId:string,c:ExecutionContext){
  const id=randomUUID();
  await this.pool.query(`insert into peragus_sandbox_withdrawal_executions(id,operator_id,request_id,withdrawal_request_id,customer_id,approval_id,approver_id,pix_id,
   provider_customer_id,provider_wallet_id,provider_quote_id,funding_transfer_id,amount_brl,amount_usdt,send_amount_usdt,wallet_address,verified_at,idempotency_key,environment)
   select $4,$2,$3,e.withdrawal_request_id,e.customer_id,e.approval_id,e.approver_id,e.pix_id,e.provider_customer_id,e.provider_wallet_id,e.provider_quote_id,e.funding_transfer_id,e.amount_brl,e.amount_usdt,e.send_amount_usdt,e.wallet_address,e.verified_at,$5,'${this.e.mode}'
   from (${eligible(this.e)}) e where e.approval_id=$6 and e.amount_usdt=$7 and e.wallet_address=$8 and e.provider_customer_id=$9 and e.provider_wallet_id=$10 and e.funding_transfer_id=$11
    and e.send_amount_usdt=$12::numeric and not exists(select 1 from peragus_customers where owner_user_id=$2)
   on conflict do nothing`,[c.withdrawalId,operatorId,requestId,id,`peragus-send-${id}`,c.approvalId,c.amountUsdt,c.walletAddress,c.providerCustomerId,c.providerWalletId,c.transferId,c.sendAmountUsdt]);
  const row=await this.read(c.withdrawalId);if(!row)throw new SandboxExecutionError("WITHDRAWAL_PILOT_SLOT_UNAVAILABLE");
  if(row.operatorId!==operatorId || row.requestId!==requestId)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_ALREADY_REQUESTED");return row;
 }
 /**
  * Ruling 23: lock the purchase row, require `approved`, mark the execution attempted and move the
  * operation approved -> sending, all in one transaction and before any send POST. A concurrent or
  * repeated execute waits on the row lock and then finds `sending` (not approved) or the execution
  * already attempted: exactly one caller gets "claimed".
  */
 async claim(row:SandboxExecution):Promise<ExecutionClaim>{
  return this.transaction(async client=>{
   if(await this.lockOperation(client,row.purchaseId)!=="approved")return{commit:false,value:"not_approved" as const};
   const r=await client.query(`update peragus_sandbox_withdrawal_executions set create_attempted=true,updated_at=now()
    where id=$2 and not create_attempted and closed_at is null and not exists(select 1 from peragus_customers where owner_user_id=$3) and exists(${eligible(this.e)}) returning id`,[row.withdrawalId,row.id,row.operatorId]);
   if(!r.rows[0])return{commit:false,value:"taken" as const};
   await transitionOperationInTransaction(client,this.e.mode,row.purchaseId,"sending",`operator:${row.operatorId}`,`${SEND_CLAIMED}: execution=${row.id}`,{from:"approved"});
   return{commit:true,value:"claimed" as const};
  });
 }
 async bind(row:SandboxExecution,id:string,txHash:string|null=null,actor="system:withdrawal_recovery"){
  await this.transaction(async client=>{
   const status=await this.lockOperation(client,row.purchaseId);
   const r=await client.query(`update peragus_sandbox_withdrawal_executions set provider_send_id=$2,provider_tx_hash=coalesce(provider_tx_hash,$3),updated_at=now()
    where id=$1 and create_attempted and provider_refusal_code is null and (provider_send_id is null or provider_send_id=$2) returning id`,[row.id,id,txHash]);
   if(!r.rows[0])throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_BINDING_CONFLICT");
   // OZAV accepted the send (or recovery found it): sending -> sent. Other statuses are left alone.
   if(status==="sending")await transitionOperationInTransaction(client,this.e.mode,row.purchaseId,"sent",actor.slice(0,200),
    `${SEND_ACCEPTED}: transfer=${id}${txHash?` tx_hash=${txHash}`:""}`.slice(0,500),{from:"sending"});
   return{commit:true,value:undefined};
  });
 }
 async refuse(row:SandboxExecution,code:string,actor:string){
  return this.transaction(async client=>{
   await this.lockOperation(client,row.purchaseId);
   const r=await client.query<Row>(`update peragus_sandbox_withdrawal_executions set provider_refusal_code=$2,updated_at=now()
    where id=$1 and create_attempted and provider_send_id is null and observation is null and provider_refusal_code is null returning *`,[row.id,code]);
   if(!r.rows[0])throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_BINDING_CONFLICT");
   await transitionOperationInTransaction(client,this.e.mode,row.purchaseId,"needs_review",actor.slice(0,200),`${SEND_REFUSED}: ${code}`,{from:"sending"});
   return{commit:true,value:map({...r.rows[0],purchase_id:row.purchaseId})};
  });
 }
 async recordDestinationCheck(withdrawalId:string,customerId:string,blocker:string|null){
  await this.pool.query(`insert into peragus_withdrawal_destination_checks(withdrawal_request_id,customer_id,blocker,checked_at,environment)
   values($1,$2,$3,now(),'${this.e.mode}') on conflict(withdrawal_request_id) do update set blocker=excluded.blocker,checked_at=excluded.checked_at
   where peragus_withdrawal_destination_checks.customer_id=excluded.customer_id`,[withdrawalId,customerId,blocker]);
 }
 async save(row:SandboxExecution,t:WithdrawalObservation){
  validateWithdrawal(row,t);
  if(row.observation && ["completed","failed","cancelled","expired"].includes(row.observation.status) && row.observation.status!==t.status)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_TERMINAL_CONFLICT");
  const r=await this.pool.query<Row>(`update peragus_sandbox_withdrawal_executions set observation=$3::jsonb,provider_tx_hash=coalesce(provider_tx_hash,case when length($5::text)<=256 and $5::text ~ '^[!-~]+$' then $5::text end),updated_at=now()
   where id=$1 and provider_send_id=$2 and observation is not distinct from $4::jsonb returning *`,[row.id,t.id,JSON.stringify(t),row.observation?JSON.stringify(row.observation):null,t.transactionReference]);
  if(!r.rows[0])throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_REFRESH_CONFLICT");return map({...r.rows[0],purchase_id:row.purchaseId});
 }
}
