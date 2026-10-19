import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {CustomerPixError, validatePixTransfer, type CustomerPixRecord, type CustomerPixRepository, type PixContext} from "../purchases/customer-sandbox-pix.js";
import type {OzavTransfer} from "../providers/ozav-client.js";
const eligible = `select p.id as purchase_id,p.provider_customer_id,q.provider_quote_id,p.source_amount_brl,p.wallet_address
   from peragus_customer_purchase_intents p join peragus_customer_indicative_quotes q on q.id=p.quote_id and q.customer_id=p.customer_id
   join peragus_customers c on c.id=q.customer_id and c.customer_type='pf' and not c.suspended
   join peragus_customer_onboarding_submissions s on s.customer_id=q.customer_id and s.environment='test'
   join peragus_customer_terms_sessions t on t.id=s.terms_session_id and t.customer_id=q.customer_id and t.environment='test'
   join peragus_customer_verifications v on v.customer_id=q.customer_id and v.environment='test'
   join peragus_customer_screenings sc on sc.customer_id=q.customer_id and sc.environment='test'
   join peragus_customer_wallets w on w.customer_id=q.customer_id and w.environment='test' and w.network='solana:devnet'
   where p.id=$2 and p.customer_id=$1 and q.environment='test' and q.provider_quote_id is not null
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
 and p.source_amount_brl>=1000 and p.source_amount_brl=q.source_amount_brl and p.wallet_address=w.wallet_address and p.provider_customer_id=q.provider_customer_id`;
interface Row {id:string;customer_id:string;request_id:string;purchase_intent_id:string;provider_customer_id:string;provider_quote_id:string;
 source_amount_brl:string;wallet_address:string;provider_wallet_id:string;create_attempted:boolean;provider_transfer_id:string|null;observation:OzavTransfer|null;}
const map=(r:Row):CustomerPixRecord=>({id:r.id,customerId:r.customer_id,requestId:r.request_id,purchaseId:r.purchase_intent_id,
 providerCustomerId:r.provider_customer_id,providerQuoteId:r.provider_quote_id,amountBrl:r.source_amount_brl,walletAddress:r.wallet_address,
 providerWalletId:r.provider_wallet_id,attempted:r.create_attempted,transferId:r.provider_transfer_id,observation:r.observation});
export class PostgresCustomerPixRepository implements CustomerPixRepository {
 constructor(private readonly pool:Pool){}
 async context(customerId:string,purchaseId:string):Promise<PixContext|null>{
  const r=await this.pool.query(eligible,[customerId,purchaseId]),x=r.rows[0];
  return x?{purchaseId:x.purchase_id,providerCustomerId:x.provider_customer_id,providerQuoteId:x.provider_quote_id,amountBrl:x.source_amount_brl,walletAddress:x.wallet_address}:null;
 }
 async findRequest(customerId:string,requestId:string){const r=await this.pool.query<Row>("select * from peragus_customer_sandbox_pix where customer_id=$1 and request_id=$2",[customerId,requestId]);return r.rows[0]?map(r.rows[0]):null;}
 async read(customerId:string,id:string){const r=await this.pool.query<Row>("select * from peragus_customer_sandbox_pix where customer_id=$1 and id=$2",[customerId,id]);return r.rows[0]?map(r.rows[0]):null;}
 async reserve(customerId:string,requestId:string,c:PixContext,walletId:string){
  const id=randomUUID();
  await this.pool.query(`insert into peragus_customer_sandbox_pix(id,customer_id,request_id,purchase_intent_id,provider_customer_id,provider_quote_id,source_amount_brl,wallet_address,provider_wallet_id,idempotency_key)
   select $3,$1,$4,e.purchase_id,e.provider_customer_id,e.provider_quote_id,e.source_amount_brl,e.wallet_address,$5,$6 from (${eligible}) e
   where e.provider_customer_id=$7 and e.provider_quote_id=$8 and e.source_amount_brl=$9 and e.wallet_address=$10
   on conflict do nothing`,[customerId,c.purchaseId,id,requestId,walletId,`peragus-pix-${id}`,c.providerCustomerId,c.providerQuoteId,c.amountBrl,c.walletAddress]);
  const row=await this.findRequest(customerId,requestId);
  if(!row)throw new CustomerPixError("PIX_ALREADY_RESERVED_OR_INELIGIBLE");
  if(row.purchaseId!==c.purchaseId)throw new CustomerPixError("PIX_IDEMPOTENCY_CONFLICT");
  return row;
 }
 async claim(id:string){
  const row=await this.pool.query<Row>("select * from peragus_customer_sandbox_pix where id=$1",[id]);const r=row.rows[0];if(!r)return false;
  const result=await this.pool.query(`update peragus_customer_sandbox_pix set create_attempted=true,updated_at=now()
   where id=$3 and not create_attempted and exists(${eligible}) returning id`,[r.customer_id,r.purchase_intent_id,id]);return Boolean(result.rows[0]);
 }
 async bind(row:CustomerPixRecord,transferId:string){
  const r=await this.pool.query(`update peragus_customer_sandbox_pix set provider_transfer_id=$3,updated_at=now()
   where id=$1 and customer_id=$2 and create_attempted and (provider_transfer_id is null or provider_transfer_id=$3) returning id`,[row.id,row.customerId,transferId]);
  if(!r.rows[0])throw new CustomerPixError("PIX_PROVIDER_BINDING_CONFLICT");
 }
 async save(row:CustomerPixRecord,t:OzavTransfer){
  validatePixTransfer(row,t);
  if(row.observation && ["completed","failed","cancelled","expired"].includes(row.observation.status)
    && t.status!==row.observation.status)throw new CustomerPixError("PIX_TERMINAL_STATE_CONFLICT");
  // Compare-and-swap prevents overlapping GETs from overwriting a newer observation.
  const r=await this.pool.query<Row>(`update peragus_customer_sandbox_pix set observation=$4::jsonb,updated_at=now()
   where id=$1 and customer_id=$2 and provider_transfer_id=$3 and observation is not distinct from $5::jsonb returning *`,
   [row.id,row.customerId,t.id,JSON.stringify(t),row.observation===null?null:JSON.stringify(row.observation)]);
  if(!r.rows[0])throw new CustomerPixError("PIX_REFRESH_CONFLICT");return map(r.rows[0]);
 }
}
