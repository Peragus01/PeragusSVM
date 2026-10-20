import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {SandboxExecutionError,validateWithdrawal,type ExecutionContext,type SandboxExecution,type SandboxExecutionRepository} from "../withdrawals/sandbox-execution.js";
import type {WithdrawalObservation} from "../providers/ozav-sandbox-withdrawal.js";
const eligible=`select r.id as withdrawal_request_id,r.customer_id,a.id as approval_id,a.operator_user_id as approver_id,x.id as pix_id,
 x.provider_customer_id,x.provider_wallet_id,x.provider_quote_id,x.provider_transfer_id as funding_transfer_id,
 x.source_amount_brl as amount_brl,r.amount_usdt,r.wallet_address,r.wallet_verified_at as verified_at
   from peragus_customer_withdrawal_requests r join peragus_withdrawal_operator_approvals a on a.withdrawal_request_id=r.id and a.customer_id=r.customer_id and a.amount_usdt=r.amount_usdt and a.wallet_address=r.wallet_address and a.environment='test' and a.assurance_level='aal2' join peragus_customer_sandbox_pix x on x.id=r.pix_id and x.customer_id=r.customer_id and x.purchase_intent_id=r.purchase_intent_id join peragus_customer_purchase_intents p on p.id=x.purchase_intent_id and p.customer_id=x.customer_id join peragus_customer_indicative_quotes q on q.id=p.quote_id and q.customer_id=p.customer_id
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

`;
interface ContextRow {withdrawal_request_id:string;customer_id:string;approval_id:string;approver_id:string;pix_id:string;
 provider_customer_id:string;provider_wallet_id:string;provider_quote_id:string;funding_transfer_id:string;amount_brl:string;amount_usdt:string;wallet_address:string;verified_at:Date|string;}
interface Row extends ContextRow {id:string;operator_id:string;request_id:string;create_attempted:boolean;provider_send_id:string|null;observation:WithdrawalObservation|null;}
const contextMap=(r:ContextRow):ExecutionContext=>({withdrawalId:r.withdrawal_request_id,customerId:r.customer_id,approvalId:r.approval_id,approverId:r.approver_id,pixId:r.pix_id,
 providerCustomerId:r.provider_customer_id,providerWalletId:r.provider_wallet_id,providerQuoteId:r.provider_quote_id,transferId:r.funding_transfer_id,
 amountBrl:r.amount_brl,amountUsdt:r.amount_usdt,walletAddress:r.wallet_address,verifiedAt:new Date(r.verified_at).toISOString()});
const map=(r:Row):SandboxExecution=>({...contextMap(r),id:r.id,operatorId:r.operator_id,requestId:r.request_id,attempted:r.create_attempted,sendTransferId:r.provider_send_id,observation:r.observation});
export class PostgresSandboxExecutionRepository implements SandboxExecutionRepository {
 constructor(private readonly pool:Pool){}
 async context(id:string){const r=await this.pool.query<ContextRow>(eligible,[id]);return r.rows[0]?contextMap(r.rows[0]):null;}
 async read(id:string){const r=await this.pool.query<Row>("select * from peragus_sandbox_withdrawal_executions where withdrawal_request_id=$1 and environment='test'",[id]);return r.rows[0]?map(r.rows[0]):null;}
 async reserve(operatorId:string,requestId:string,c:ExecutionContext){
  const id=randomUUID();
  await this.pool.query(`insert into peragus_sandbox_withdrawal_executions(id,operator_id,request_id,withdrawal_request_id,customer_id,approval_id,approver_id,pix_id,
   provider_customer_id,provider_wallet_id,provider_quote_id,funding_transfer_id,amount_brl,amount_usdt,wallet_address,verified_at,idempotency_key)
   select $4,$2,$3,e.withdrawal_request_id,e.customer_id,e.approval_id,e.approver_id,e.pix_id,e.provider_customer_id,e.provider_wallet_id,e.provider_quote_id,e.funding_transfer_id,e.amount_brl,e.amount_usdt,e.wallet_address,e.verified_at,$5
   from (${eligible}) e where e.approval_id=$6 and e.amount_usdt=$7 and e.wallet_address=$8 and e.provider_customer_id=$9 and e.provider_wallet_id=$10 and e.funding_transfer_id=$11
    and not exists(select 1 from peragus_customers where owner_user_id=$2)
   on conflict do nothing`,[c.withdrawalId,operatorId,requestId,id,`peragus-send-${id}`,c.approvalId,c.amountUsdt,c.walletAddress,c.providerCustomerId,c.providerWalletId,c.transferId]);
  const row=await this.read(c.withdrawalId);if(!row)throw new SandboxExecutionError("WITHDRAWAL_PILOT_SLOT_UNAVAILABLE");
  if(row.operatorId!==operatorId || row.requestId!==requestId)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_ALREADY_REQUESTED");return row;
 }
 async claim(row:SandboxExecution){const r=await this.pool.query(`update peragus_sandbox_withdrawal_executions set create_attempted=true,updated_at=now()
  where id=$2 and not create_attempted and closed_at is null and not exists(select 1 from peragus_customers where owner_user_id=$3) and exists(${eligible}) returning id`,[row.withdrawalId,row.id,row.operatorId]);return Boolean(r.rows[0]);}
 async bind(row:SandboxExecution,id:string){const r=await this.pool.query(`update peragus_sandbox_withdrawal_executions set provider_send_id=$2,updated_at=now()
  where id=$1 and create_attempted and (provider_send_id is null or provider_send_id=$2) returning id`,[row.id,id]);if(!r.rows[0])throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_BINDING_CONFLICT");}
 async save(row:SandboxExecution,t:WithdrawalObservation){
  validateWithdrawal(row,t);
  if(row.observation && ["completed","failed","cancelled","expired"].includes(row.observation.status) && row.observation.status!==t.status)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_TERMINAL_CONFLICT");
  const r=await this.pool.query<Row>(`update peragus_sandbox_withdrawal_executions set observation=$3::jsonb,updated_at=now()
   where id=$1 and provider_send_id=$2 and observation is not distinct from $4::jsonb returning *`,[row.id,t.id,JSON.stringify(t),row.observation?JSON.stringify(row.observation):null]);
  if(!r.rows[0])throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_REFRESH_CONFLICT");return map(r.rows[0]);
 }
}
