import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import {transitionOperationInTransaction} from "./postgres-customer-purchase-intents.js";
import {PurchaseIntentError} from "../purchases/customer-purchase-intents.js";
import {OperatorApprovalError,type OperatorApproval,type OperatorApprovalRepository} from "../withdrawals/operator-approvals.js";
/** True when the operation already has an operator refund decision or an approved manual refund. */
const REFUND_DECIDED=(p:string)=>`(exists(select 1 from peragus_operator_refund_decisions od where od.purchase_id=${p}.id)
 or exists(select 1 from peragus_manual_refund_decisions md join peragus_customer_refund_requests rr on rr.id=md.refund_request_id and rr.customer_id=md.customer_id
  where rr.purchase_intent_id=${p}.id and md.decision='approved'))`;
interface Row {id:string;withdrawal_request_id:string;customer_id:string;operator_user_id:string;request_id:string;reason:string;amount_usdt:string;wallet_address:string;created_at:Date|string;execution_attempted?:boolean;}
const map=(r:Row):OperatorApproval=>({id:r.id,withdrawalId:r.withdrawal_request_id,customerId:r.customer_id,operatorId:r.operator_user_id,requestId:r.request_id,reason:r.reason,amountUsdt:r.amount_usdt,walletAddress:r.wallet_address,createdAt:new Date(r.created_at).toISOString(),executionAttempted:r.execution_attempted===true});
export class PostgresWithdrawalOperatorApprovalRepository implements OperatorApprovalRepository {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pool,mode:MoneyMode){this.e=rowEnvironment(mode);}
 async read(id:string){const r=await this.pool.query<Row>(`select a.*,e.create_attempted as execution_attempted from peragus_withdrawal_operator_approvals a left join peragus_sandbox_withdrawal_executions e on e.withdrawal_request_id=a.withdrawal_request_id where a.withdrawal_request_id=$1 and a.environment='${this.e.mode}'`,[id]);return r.rows[0]?map(r.rows[0]):null;}
 private async findRequest(operatorId:string,requestId:string){const r=await this.pool.query<Row>("select a.*,e.create_attempted as execution_attempted from peragus_withdrawal_operator_approvals a left join peragus_sandbox_withdrawal_executions e on e.withdrawal_request_id=a.withdrawal_request_id where a.operator_user_id=$1 and a.request_id=$2",[operatorId,requestId]);return r.rows[0]?map(r.rows[0]):null;}
 private replay(r:OperatorApproval,id:string,reason:string){if(r.withdrawalId!==id || r.reason!==reason)throw new OperatorApprovalError("WITHDRAWAL_APPROVAL_IDEMPOTENCY_CONFLICT");return{record:r,replayed:true};}
 /** Runs work in one transaction on a dedicated connection; a failed rollback discards the connection. */
 private async inTransaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect();let broken:Error|undefined;
  try{
   await client.query("begin isolation level read committed");
   const result=await work(client);
   await client.query("commit");
   return result;
  }catch(error){
   try{await client.query("rollback");}catch(rollbackError){broken=rollbackError instanceof Error?rollbackError:new Error("ROLLBACK_FAILED");}
   throw error;
  }finally{client.release(broken);}
 }
 /**
  * Ruling 23: under the purchase row lock (`for update`), the approval is recorded only
  * while the operation is awaiting_approval and no refund decision exists, and the
  * operation moves awaiting_approval -> approved in the SAME transaction. A concurrent
  * operator refund decision (which takes the same lock) therefore sees either no
  * approval and awaiting_approval, or the approval and `approved` — never both paths.
  */
 async record(id:string,operatorId:string,requestId:string,reason:string){
  const prior=await this.findRequest(operatorId,requestId);if(prior)return this.replay(prior,id,reason);
  let recorded:OperatorApproval|null;
  try{
   recorded=await this.inTransaction(async client=>{
    const locked=await client.query<{id:string}>(`select p.id from peragus_customer_purchase_intents p
     join peragus_customer_withdrawal_requests r on r.purchase_intent_id=p.id and r.customer_id=p.customer_id
     where r.id=$1 and r.environment='${this.e.mode}' and p.environment='${this.e.mode}' for update of p`,[id]);
    const purchaseId=locked.rows[0]?.id;if(!purchaseId)return null;
    const row=await this.insert(client,id,operatorId,requestId,reason);if(!row)return null;
    await transitionOperationInTransaction(client,this.e.mode,purchaseId,"approved",`operator:${operatorId}`,
     `OPERATOR_WITHDRAWAL_APPROVAL: ${reason}`.slice(0,500),{from:"awaiting_approval"});
    return map(row);
   });
  }catch(error){
   if(error instanceof PurchaseIntentError && error.code==="OPERATION_INVALID_TRANSITION")throw new OperatorApprovalError("WITHDRAWAL_OPERATION_NOT_AWAITING_APPROVAL");
   throw error;
  }
  if(recorded)return{record:recorded,replayed:false};
  const raced=await this.findRequest(operatorId,requestId);if(raced)return this.replay(raced,id,reason);
  if(await this.read(id))throw new OperatorApprovalError("WITHDRAWAL_APPROVAL_ALREADY_RECORDED");
  const exists=await this.pool.query("select id from peragus_customer_withdrawal_requests where id=$1",[id]);
  if(!exists.rows[0])throw new OperatorApprovalError("WITHDRAWAL_REQUEST_NOT_FOUND");
  const op=await this.pool.query<{status:string;refund:boolean}>(`select p.status,${REFUND_DECIDED("p")} as refund
   from peragus_customer_purchase_intents p join peragus_customer_withdrawal_requests r on r.purchase_intent_id=p.id and r.customer_id=p.customer_id
   where r.id=$1 and p.environment='${this.e.mode}'`,[id]);
  const state=op.rows[0];
  if(state && (state.refund || ["refund_pending","refunded"].includes(state.status)))throw new OperatorApprovalError("WITHDRAWAL_REFUND_IN_PROGRESS");
  if(state && state.status!=="awaiting_approval")throw new OperatorApprovalError("WITHDRAWAL_OPERATION_NOT_AWAITING_APPROVAL");
  throw new OperatorApprovalError("WITHDRAWAL_APPROVAL_PREREQUISITES_REQUIRED");
 }
 private async insert(client:Pick<PoolClient,"query">,id:string,operatorId:string,requestId:string,reason:string){
  const result=await client.query<Row>(`insert into peragus_withdrawal_operator_approvals(
   id,withdrawal_request_id,customer_id,operator_user_id,request_id,assurance_level,reason,amount_usdt,wallet_address,environment)
   select $4,r.id,r.customer_id,$2,$3,'aal2',$5,r.amount_usdt,r.wallet_address,'${this.e.mode}'
   from peragus_customer_withdrawal_requests r join peragus_customer_sandbox_pix x on x.id=r.pix_id and x.customer_id=r.customer_id and x.purchase_intent_id=r.purchase_intent_id join peragus_customer_purchase_intents p on p.id=x.purchase_intent_id and p.customer_id=x.customer_id join peragus_customer_indicative_quotes q on q.id=p.quote_id and q.customer_id=p.customer_id
   join peragus_customers c on c.id=q.customer_id and c.customer_type='pf' and not c.suspended
   join peragus_customer_onboarding_submissions s on s.customer_id=q.customer_id and s.environment='${this.e.mode}'
   join peragus_customer_terms_sessions t on t.id=s.terms_session_id and t.customer_id=q.customer_id and t.environment='${this.e.mode}'
   join peragus_customer_verifications v on v.customer_id=q.customer_id and v.environment='${this.e.mode}'
   join peragus_customer_screenings sc on sc.customer_id=q.customer_id and sc.environment='${this.e.mode}'
   join peragus_customer_wallets w on w.customer_id=q.customer_id and w.environment='${this.e.mode}' and w.network='${this.e.network}'
   where r.id=$1 and q.environment='${this.e.mode}' and q.provider_quote_id is not null
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
 and x.environment='${this.e.mode}' and p.environment='${this.e.mode}' and x.create_attempted and x.provider_transfer_id is not null
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

 and r.environment='${this.e.mode}' and r.record_only and r.state='recorded'
 and r.provider_customer_id=x.provider_customer_id and r.provider_wallet_id=x.provider_wallet_id and r.provider_transfer_id=x.provider_transfer_id
 and r.wallet_address=p.wallet_address and r.wallet_address=w.wallet_address
 and r.amount_usdt=(x.observation->'amounts'->'target'->>'amount')::numeric
 and not exists(select 1 from peragus_customers operator_customer where operator_customer.owner_user_id=$2)
 -- Ruling 23 (the caller holds the purchase row lock): only an operation awaiting
 -- approval, and never one with a refund decision.
 and p.status='awaiting_approval' and not ${REFUND_DECIDED("p")}

 on conflict do nothing returning *`,[id,operatorId,requestId,randomUUID(),reason]);
  return result.rows[0]??null;
 }
}
