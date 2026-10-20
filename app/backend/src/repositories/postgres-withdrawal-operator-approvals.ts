import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {OperatorApprovalError,type OperatorApproval,type OperatorApprovalRepository} from "../withdrawals/operator-approvals.js";
interface Row {id:string;withdrawal_request_id:string;customer_id:string;operator_user_id:string;request_id:string;reason:string;amount_usdt:string;wallet_address:string;created_at:Date|string;}
const map=(r:Row):OperatorApproval=>({id:r.id,withdrawalId:r.withdrawal_request_id,customerId:r.customer_id,operatorId:r.operator_user_id,requestId:r.request_id,reason:r.reason,amountUsdt:r.amount_usdt,walletAddress:r.wallet_address,createdAt:new Date(r.created_at).toISOString()});
export class PostgresWithdrawalOperatorApprovalRepository implements OperatorApprovalRepository {
 constructor(private readonly pool:Pool){}
 async read(id:string){const r=await this.pool.query<Row>("select * from peragus_withdrawal_operator_approvals where withdrawal_request_id=$1 and environment='test'",[id]);return r.rows[0]?map(r.rows[0]):null;}
 private async findRequest(operatorId:string,requestId:string){const r=await this.pool.query<Row>("select * from peragus_withdrawal_operator_approvals where operator_user_id=$1 and request_id=$2",[operatorId,requestId]);return r.rows[0]?map(r.rows[0]):null;}
 private replay(r:OperatorApproval,id:string,reason:string){if(r.withdrawalId!==id || r.reason!==reason)throw new OperatorApprovalError("WITHDRAWAL_APPROVAL_IDEMPOTENCY_CONFLICT");return{record:r,replayed:true};}
 async record(id:string,operatorId:string,requestId:string,reason:string){
  const prior=await this.findRequest(operatorId,requestId);if(prior)return this.replay(prior,id,reason);
  const result=await this.pool.query<Row>(`insert into peragus_withdrawal_operator_approvals(
   id,withdrawal_request_id,customer_id,operator_user_id,request_id,assurance_level,reason,amount_usdt,wallet_address)
   select $4,r.id,r.customer_id,$2,$3,'aal2',$5,r.amount_usdt,r.wallet_address
   from peragus_customer_withdrawal_requests r join peragus_customer_sandbox_pix x on x.id=r.pix_id and x.customer_id=r.customer_id and x.purchase_intent_id=r.purchase_intent_id join peragus_customer_purchase_intents p on p.id=x.purchase_intent_id and p.customer_id=x.customer_id join peragus_customer_indicative_quotes q on q.id=p.quote_id and q.customer_id=p.customer_id
   join peragus_customers c on c.id=q.customer_id and c.customer_type='pf' and not c.suspended
   join peragus_customer_onboarding_submissions s on s.customer_id=q.customer_id and s.environment='test'
   join peragus_customer_terms_sessions t on t.id=s.terms_session_id and t.customer_id=q.customer_id and t.environment='test'
   join peragus_customer_verifications v on v.customer_id=q.customer_id and v.environment='test'
   join peragus_customer_screenings sc on sc.customer_id=q.customer_id and sc.environment='test'
   join peragus_customer_wallets w on w.customer_id=q.customer_id and w.environment='test' and w.network='solana:devnet'
   where r.id=$1 and q.environment='test' and q.provider_quote_id is not null
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
 and x.environment='test' and p.environment='test' and x.create_attempted and x.provider_transfer_id is not null
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

 and r.environment='test' and r.record_only and r.state='recorded'
 and r.provider_customer_id=x.provider_customer_id and r.provider_wallet_id=x.provider_wallet_id and r.provider_transfer_id=x.provider_transfer_id
 and r.wallet_address=p.wallet_address and r.wallet_address=w.wallet_address
 and r.amount_usdt=(x.observation->'amounts'->'target'->>'amount')::numeric
 and not exists(select 1 from peragus_customers operator_customer where operator_customer.owner_user_id=$2)

 on conflict do nothing returning *`,[id,operatorId,requestId,randomUUID(),reason]);
  if(result.rows[0])return{record:map(result.rows[0]),replayed:false};
  const raced=await this.findRequest(operatorId,requestId);if(raced)return this.replay(raced,id,reason);
  if(await this.read(id))throw new OperatorApprovalError("WITHDRAWAL_APPROVAL_ALREADY_RECORDED");
  const exists=await this.pool.query("select id from peragus_customer_withdrawal_requests where id=$1",[id]);
  if(!exists.rows[0])throw new OperatorApprovalError("WITHDRAWAL_REQUEST_NOT_FOUND");
  throw new OperatorApprovalError("WITHDRAWAL_APPROVAL_PREREQUISITES_REQUIRED");
 }
}
