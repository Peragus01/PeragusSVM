import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import {CustomerPixError, validatePixTransfer, type CustomerPixRecord, type CustomerPixRepository, type PixContext} from "../purchases/customer-sandbox-pix.js";
import type {OzavTransfer} from "../providers/ozav-client.js";
import type {OperationStatus} from "../purchases/operation-status.js";
// A Pix is created only for an accepted operation; a sandbox simulation may follow once it awaits the Pix.
const CREATE:readonly OperationStatus[]=["accepted"],FUNDING:readonly OperationStatus[]=["accepted","awaiting_pix"];
// Statuses come from the closed constants above, so they may be inlined as SQL literals.
const eligible = (env:RowEnvironment,statuses:readonly OperationStatus[]) => `select p.id as purchase_id,p.provider_customer_id,q.provider_quote_id,p.source_amount_brl,p.wallet_address,
   p.facility_terms_version,p.locked_usdt_amount
   from peragus_customer_purchase_intents p join peragus_customer_indicative_quotes q on q.id=p.quote_id and q.customer_id=p.customer_id
   join peragus_customers c on c.id=q.customer_id and c.customer_type='pf' and not c.suspended
   join peragus_customer_onboarding_submissions s on s.customer_id=q.customer_id and s.environment='${env.mode}'
   join peragus_customer_terms_sessions t on t.id=s.terms_session_id and t.customer_id=q.customer_id and t.environment='${env.mode}'
   join peragus_customer_verifications v on v.customer_id=q.customer_id and v.environment='${env.mode}'
   join peragus_customer_screenings sc on sc.customer_id=q.customer_id and sc.environment='${env.mode}'
   join peragus_customer_wallets w on w.customer_id=q.customer_id and w.environment='${env.mode}' and w.network='${env.network}'
   where p.id=$2 and p.customer_id=$1 and q.environment='${env.mode}' and q.provider_quote_id is not null
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
 and p.source_amount_brl>=1000 and p.source_amount_brl=q.source_amount_brl and p.wallet_address=w.wallet_address and p.provider_customer_id=q.provider_customer_id
 and p.environment='${env.mode}' and p.status in (${statuses.map(v=>`'${v}'`).join(",")})
 ${env.mode==="live"?"and p.facility_terms_version is not null and p.locked_usdt_amount is not null":""}`;
// Each Pix row with the status and lock fields of the operation it funds.
const WITH_OPERATION=(source:string)=>`select x.*,p.status as operation_status,p.facility_terms_version,p.locked_usdt_amount
 from ${source} x join peragus_customer_purchase_intents p on p.id=x.purchase_intent_id and p.customer_id=x.customer_id`;
interface Row {id:string;customer_id:string;request_id:string;purchase_intent_id:string;provider_customer_id:string;provider_quote_id:string;
 source_amount_brl:string;wallet_address:string;provider_wallet_id:string;create_attempted:boolean;simulation_attempted:boolean;provider_transfer_id:string|null;observation:OzavTransfer|null;
 operation_status:OperationStatus;facility_terms_version:string|null;locked_usdt_amount:string|null;lock_deadline_at?:Date|string|null;}
const map=(r:Row):CustomerPixRecord=>({id:r.id,customerId:r.customer_id,requestId:r.request_id,purchaseId:r.purchase_intent_id,
 providerCustomerId:r.provider_customer_id,providerQuoteId:r.provider_quote_id,amountBrl:r.source_amount_brl,walletAddress:r.wallet_address,
 providerWalletId:r.provider_wallet_id,attempted:r.create_attempted,simulationAttempted:r.simulation_attempted,transferId:r.provider_transfer_id,observation:r.observation,
 operationStatus:r.operation_status,facilityTermsVersion:r.facility_terms_version,
 lockDeadlineAt:r.lock_deadline_at==null?null:new Date(r.lock_deadline_at).toISOString(),...(r.locked_usdt_amount===null?{}:{lockedUsdtAmount:r.locked_usdt_amount})});
export class PostgresCustomerPixRepository implements CustomerPixRepository {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pool,mode:MoneyMode){this.e=rowEnvironment(mode);}
 async context(customerId:string,purchaseId:string,stage?:"create"):Promise<PixContext|null>{
  const r=await this.pool.query(eligible(this.e,stage==="create"?CREATE:FUNDING),[customerId,purchaseId]),x=r.rows[0];
  return x?{purchaseId:x.purchase_id,providerCustomerId:x.provider_customer_id,providerQuoteId:x.provider_quote_id,amountBrl:x.source_amount_brl,walletAddress:x.wallet_address,
   facilityTermsVersion:x.facility_terms_version,lockedUsdtAmount:x.locked_usdt_amount}:null;
 }
 async findRequest(customerId:string,requestId:string){const r=await this.pool.query<Row>(`${WITH_OPERATION("peragus_customer_sandbox_pix")} where x.customer_id=$1 and x.request_id=$2 and x.environment='${this.e.mode}'`,[customerId,requestId]);return r.rows[0]?map(r.rows[0]):null;}
 async read(customerId:string,id:string){const r=await this.pool.query<Row>(`${WITH_OPERATION("peragus_customer_sandbox_pix")} where x.customer_id=$1 and x.id=$2 and x.environment='${this.e.mode}'`,[customerId,id]);return r.rows[0]?map(r.rows[0]):null;}
 async reserve(customerId:string,requestId:string,c:PixContext,walletId:string){
  const id=randomUUID();
  await this.pool.query(`insert into peragus_customer_sandbox_pix(id,customer_id,request_id,purchase_intent_id,provider_customer_id,provider_quote_id,source_amount_brl,wallet_address,provider_wallet_id,idempotency_key,environment)
   select $3,$1,$4,e.purchase_id,e.provider_customer_id,e.provider_quote_id,e.source_amount_brl,e.wallet_address,$5,$6,'${this.e.mode}' from (${eligible(this.e,CREATE)}) e
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
   where id=$3 and not create_attempted and exists(${eligible(this.e,CREATE)}) returning id`,[r.customer_id,r.purchase_intent_id,id]);return Boolean(result.rows[0]);
 }
 async claimSimulation(row:CustomerPixRecord){
  const r=await this.pool.query(`update peragus_customer_sandbox_pix set simulation_attempted=true,simulation_attempted_at=now(),updated_at=now()
   where id=$3 and customer_id=$1 and purchase_intent_id=$2 and not simulation_attempted and create_attempted
    and provider_transfer_id=$4 and observation->>'status'='awaiting_payment'
    and (observation->'source'->'paymentInstructions'->>'expiresAt')::timestamptz>clock_timestamp()
    and exists(${eligible(this.e,FUNDING)}) returning id`,[row.customerId,row.purchaseId,row.id,row.transferId]);
  return Boolean(r.rows[0]);
 }
 async recordLockDeadline(row:CustomerPixRecord,deadlineAt:string){
  const r=await this.pool.query(`update peragus_customer_sandbox_pix set lock_deadline_at=$3::timestamptz,updated_at=now()
   where id=$1 and customer_id=$2 and environment='${this.e.mode}' and provider_transfer_id is not null
    and (lock_deadline_at is null or lock_deadline_at=$3::timestamptz) returning id`,[row.id,row.customerId,deadlineAt]);
  if(!r.rows[0])throw new CustomerPixError("PIX_LOCK_DEADLINE_CONFLICT");
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
  const r=await this.pool.query<Row>(`with u as (update peragus_customer_sandbox_pix set observation=$4::jsonb,updated_at=now()
   where id=$1 and customer_id=$2 and provider_transfer_id=$3 and observation is not distinct from $5::jsonb returning *)
   ${WITH_OPERATION("u")}`,
   [row.id,row.customerId,t.id,JSON.stringify(t),row.observation===null?null:JSON.stringify(row.observation)]);
  if(!r.rows[0])throw new CustomerPixError("PIX_REFRESH_CONFLICT");return map(r.rows[0]);
 }
}
