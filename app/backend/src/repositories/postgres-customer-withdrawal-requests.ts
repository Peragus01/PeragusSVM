import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {WithdrawalRequestError, type WithdrawalRequest, type WithdrawalRequestRepository} from "../withdrawals/customer-withdrawal-requests.js";
interface Row {id:string;customer_id:string;request_id:string;pix_id:string;purchase_intent_id:string;amount_usdt:string;wallet_address:string;wallet_verified_at:Date|string;created_at:Date|string;}
const map=(r:Row):WithdrawalRequest=>({id:r.id,customerId:r.customer_id,requestId:r.request_id,pixId:r.pix_id,purchaseId:r.purchase_intent_id,
 amountUsdt:r.amount_usdt,walletAddress:r.wallet_address,walletVerifiedAt:new Date(r.wallet_verified_at).toISOString(),createdAt:new Date(r.created_at).toISOString()});
export class PostgresCustomerWithdrawalRequestRepository implements WithdrawalRequestRepository {
 constructor(private readonly pool:Pool){}
 async read(customerId:string,id:string){const r=await this.pool.query<Row>("select * from peragus_customer_withdrawal_requests where customer_id=$1 and id=$2 and environment='test'",[customerId,id]);return r.rows[0]?map(r.rows[0]):null;}
 private async findRequest(customerId:string,requestId:string){const r=await this.pool.query<Row>("select * from peragus_customer_withdrawal_requests where customer_id=$1 and request_id=$2 and environment='test'",[customerId,requestId]);return r.rows[0]?map(r.rows[0]):null;}
 private replay(record:WithdrawalRequest,pixId:string){if(record.pixId!==pixId)throw new WithdrawalRequestError("WITHDRAWAL_IDEMPOTENCY_CONFLICT");return{record,replayed:true};}
 async record(customerId:string,requestId:string,pixId:string){
  const prior=await this.findRequest(customerId,requestId);if(prior)return this.replay(prior,pixId);
  // Frozen derivation from ONE database statement/snapshot, never caller amounts.
  const r=await this.pool.query<Row>(`insert into peragus_customer_withdrawal_requests(
   id,customer_id,request_id,pix_id,purchase_intent_id,provider_customer_id,provider_wallet_id,provider_transfer_id,
   amount_usdt,wallet_address,wallet_verified_at,evidence_snapshot)
  select $1,x.customer_id,$3,x.id,p.id,x.provider_customer_id,x.provider_wallet_id,x.provider_transfer_id,
   (x.observation->'amounts'->'target'->>'amount')::numeric,p.wallet_address,w.verified_at,
   jsonb_build_object('pix_observed_at',x.updated_at,'transfer_status',x.observation->>'status',
    'source_leg_status',x.observation->>'sourceLegStatus','destination_leg_status',x.observation->>'destinationLegStatus',
    'registration_snapshot_version',s.snapshot_version,'verification_revision',v.revision,'screening_revision',sc.revision,
    'terms_session_id',t.id,'wallet_proof_id',w.proof_challenge_id)
   from peragus_customer_sandbox_pix x join peragus_customer_purchase_intents p on p.id=x.purchase_intent_id and p.customer_id=x.customer_id join peragus_customer_indicative_quotes q on q.id=p.quote_id and q.customer_id=p.customer_id
   join peragus_customers c on c.id=q.customer_id and c.customer_type='pf' and not c.suspended
   join peragus_customer_onboarding_submissions s on s.customer_id=q.customer_id and s.environment='test'
   join peragus_customer_terms_sessions t on t.id=s.terms_session_id and t.customer_id=q.customer_id and t.environment='test'
   join peragus_customer_verifications v on v.customer_id=q.customer_id and v.environment='test'
   join peragus_customer_screenings sc on sc.customer_id=q.customer_id and sc.environment='test'
   join peragus_customer_wallets w on w.customer_id=q.customer_id and w.environment='test' and w.network='solana:devnet'
   where x.id=$4 and x.customer_id=$2 and q.environment='test' and q.provider_quote_id is not null
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

 on conflict do nothing returning *`,[randomUUID(),customerId,requestId,pixId]);
  if(r.rows[0])return{record:map(r.rows[0]),replayed:false};
  const raced=await this.findRequest(customerId,requestId);if(raced)return this.replay(raced,pixId);
  const owned=await this.pool.query("select id from peragus_customer_sandbox_pix where id=$1 and customer_id=$2 and environment='test'",[pixId,customerId]);
  if(!owned.rows[0])throw new WithdrawalRequestError("WITHDRAWAL_PIX_NOT_FOUND");
  const used=await this.pool.query("select id from peragus_customer_withdrawal_requests where pix_id=$1 and customer_id=$2",[pixId,customerId]);
  if(used.rows[0])throw new WithdrawalRequestError("WITHDRAWAL_ALREADY_RECORDED");
  throw new WithdrawalRequestError("WITHDRAWAL_PREREQUISITES_NOT_RECORDED");
 }
}
