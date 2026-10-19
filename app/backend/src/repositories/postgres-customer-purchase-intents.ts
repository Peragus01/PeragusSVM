import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {PurchaseIntentError,type PurchaseIntent,type PurchaseIntentRepository} from "../purchases/customer-purchase-intents.js";
interface Row {id:string;customer_id:string;request_id:string;quote_id:string;source_amount_brl:string;
 estimated_target_amount_usdt:string;quote_snapshot:PurchaseIntent["quoteSnapshot"];wallet_address:string;wallet_verified_at:Date|string;created_at:Date|string;}
const map=(r:Row):PurchaseIntent=>({id:r.id,customerId:r.customer_id,requestId:r.request_id,quoteId:r.quote_id,sourceAmountBrl:r.source_amount_brl,
 estimatedTargetAmountUsdt:r.estimated_target_amount_usdt,quoteSnapshot:r.quote_snapshot,walletAddress:r.wallet_address,
 walletVerifiedAt:new Date(r.wallet_verified_at).toISOString(),createdAt:new Date(r.created_at).toISOString()});
export class PostgresCustomerPurchaseIntentRepository implements PurchaseIntentRepository {
 constructor(private readonly pool:Pool){}
 async read(customerId:string,id:string){const r=await this.pool.query<Row>("select * from peragus_customer_purchase_intents where customer_id=$1 and id=$2 and environment='test'",[customerId,id]);return r.rows[0]?map(r.rows[0]):null;}
 private async findRequest(customerId:string,requestId:string){const r=await this.pool.query<Row>("select * from peragus_customer_purchase_intents where customer_id=$1 and request_id=$2 and environment='test'",[customerId,requestId]);return r.rows[0]?map(r.rows[0]):null;}
 private replay(record:PurchaseIntent,quoteId:string){if(record.quoteId!==quoteId)throw new PurchaseIntentError("PURCHASE_IDEMPOTENCY_CONFLICT");return{record,replayed:true};}
 async record(customerId:string,requestId:string,quoteId:string){
  const prior=await this.findRequest(customerId,requestId);if(prior)return this.replay(prior,quoteId);
  // Derivation, prerequisite reads and insert use ONE SQL statement/snapshot.
  // No caller-supplied amount, address, provider ID or approval can enter it.
  const r=await this.pool.query<Row>(`insert into peragus_customer_purchase_intents(
    id,customer_id,request_id,quote_id,provider_customer_id,source_amount_brl,estimated_target_amount_usdt,
    quote_snapshot,wallet_address,wallet_verified_at,evidence_snapshot)
   select $1,q.customer_id,$3,q.id,q.provider_customer_id,q.source_amount_brl,(q.observation->'target'->>'amount')::numeric,
    jsonb_build_object('rate',q.observation->>'rate','rate_type',q.observation->>'rateType','quoted_at',q.observation->>'createdAt',
     'exchange_conditions',jsonb_build_object('spread_bps',q.observation->'spreadBps','rate_without_spread',q.observation->'rateWithoutSpread','amount_deducted',q.observation->'amountDeducted')),
    w.wallet_address,w.verified_at,jsonb_build_object('registration_snapshot_version',s.snapshot_version,
     'verification_revision',v.revision,'screening_revision',sc.revision,'terms_session_id',t.id,'wallet_proof_id',w.proof_challenge_id)
   from peragus_customer_indicative_quotes q
   join peragus_customers c on c.id=q.customer_id and c.customer_type='pf' and not c.suspended
   join peragus_customer_onboarding_submissions s on s.customer_id=q.customer_id and s.environment='test'
   join peragus_customer_terms_sessions t on t.id=s.terms_session_id and t.customer_id=q.customer_id and t.environment='test'
   join peragus_customer_verifications v on v.customer_id=q.customer_id and v.environment='test'
   join peragus_customer_screenings sc on sc.customer_id=q.customer_id and sc.environment='test'
   join peragus_customer_wallets w on w.customer_id=q.customer_id and w.environment='test' and w.network='solana:devnet'
   where q.id=$4 and q.customer_id=$2 and q.environment='test' and q.provider_quote_id is not null
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
   on conflict do nothing returning *`,[randomUUID(),customerId,requestId,quoteId]);
  if(r.rows[0])return{record:map(r.rows[0]),replayed:false};
  // Resolve competing inserts without overwriting an already recorded intent.
  const raced=await this.findRequest(customerId,requestId);if(raced)return this.replay(raced,quoteId);
  const quote=await this.pool.query("select id from peragus_customer_indicative_quotes where customer_id=$1 and id=$2 and environment='test'",[customerId,quoteId]);
  if(!quote.rows[0])throw new PurchaseIntentError("PURCHASE_QUOTE_NOT_FOUND");
  const used=await this.pool.query("select id from peragus_customer_purchase_intents where customer_id=$1 and quote_id=$2 and environment='test'",[customerId,quoteId]);
  if(used.rows[0])throw new PurchaseIntentError("PURCHASE_QUOTE_ALREADY_RECORDED");
  throw new PurchaseIntentError("PURCHASE_PREREQUISITES_NOT_RECORDED");
 }
}
