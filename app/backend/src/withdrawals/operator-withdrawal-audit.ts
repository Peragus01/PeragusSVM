import type {Pool} from "pg";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {authorizeWithdrawalOperator} from "./operator-approvals.js";

export class OperatorAuditNotFound extends Error {}
interface AuditRow {
 refund_id:string|null;refund_state:string|null;
 id:string;customer_id:string;created_at:Date|string;amount_usdt:string;wallet_address:string;wallet_verified_at:Date|string;
 purchase_id:string|null;purchase_created_at:Date|string|null;source_amount_brl:string|null;estimated_target_amount_usdt:string|null;
 pix_id:string|null;pix_created_at:Date|string|null;pix_updated_at:Date|string|null;pix_attempted:boolean|null;
 pix_status:string|null;pix_source_status:string|null;pix_destination_status:string|null;pix_converted_amount:string|null;
 approval_id:string|null;approved_at:Date|string|null;operator_id:string|null;reason:string|null;
 execution_id:string|null;execution_created_at:Date|string|null;execution_updated_at:Date|string|null;
 attempted:boolean|null;execution_status:string|null;execution_source_status:string|null;execution_destination_status:string|null;
 target_amount:string|null;pilot_slot_held:boolean|null;
 purchase_matches:boolean|null;pix_matches:boolean|null;approval_matches:boolean|null;execution_matches:boolean|null;
}
const iso=(value:Date|string|null)=>value?new Date(value).toISOString():null;
const units=(value:string|null)=>{
 if(value===null || !/^\d{1,15}(\.\d{1,6})?$/.test(value))return null;
 const [whole,fraction=""]=value.split(".");
 return BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,"0"));
};
const positive=(value:string|null)=>{const amount=units(value);return amount!==null && amount>0n?value:null;};
const completed=(state:string|null,source:string|null,destination:string|null)=>state==="completed" && source==="completed" && destination==="completed";

/** Immutable decision evidence and saved lifecycle facts; never refreshes or executes. */
export class OperatorWithdrawalAuditService {
 constructor(private readonly pool:Pick<Pool,"query">,private readonly operators:ReadonlySet<string>){}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.operators);}
 async read(user:AuthenticatedUser,id:string){
  this.authorize(user);
  const result=await this.pool.query<AuditRow>(`select rf.id as refund_id,
   case when rc.id is not null then 'refund_recorded' else coalesce(rd.decision,'pending_review') end as refund_state,r.id,r.customer_id,r.created_at,r.amount_usdt,r.wallet_address,r.wallet_verified_at,
   p.id as purchase_id,p.created_at as purchase_created_at,p.source_amount_brl,p.estimated_target_amount_usdt,
   x.id as pix_id,x.created_at as pix_created_at,x.updated_at as pix_updated_at,x.create_attempted as pix_attempted,
   x.observation->>'status' as pix_status,x.observation->>'sourceLegStatus' as pix_source_status,
   x.observation->>'destinationLegStatus' as pix_destination_status,
   case when x.observation->'amounts'->'target'->>'currency'='USDT' then x.observation->'amounts'->'target'->>'amount' end as pix_converted_amount,
   a.id as approval_id,a.created_at as approved_at,a.operator_user_id as operator_id,a.reason,
   e.id as execution_id,e.created_at as execution_created_at,e.updated_at as execution_updated_at,e.create_attempted as attempted,
   e.observation->>'status' as execution_status,e.observation->>'sourceLegStatus' as execution_source_status,
   e.observation->>'destinationLegStatus' as execution_destination_status,e.observation->>'targetAmount' as target_amount,
   (e.closed_at is null) as pilot_slot_held,
   (p.wallet_address=r.wallet_address and p.wallet_proof_network=r.proof_network) as purchase_matches,
   (x.purchase_intent_id=r.purchase_intent_id and x.provider_transfer_id=r.provider_transfer_id
    and x.provider_customer_id=r.provider_customer_id and x.provider_wallet_id=r.provider_wallet_id
    and x.wallet_address=r.wallet_address and x.source_amount_brl=p.source_amount_brl) as pix_matches,
   (a.amount_usdt=r.amount_usdt and a.wallet_address=r.wallet_address and a.assurance_level='aal2') as approval_matches,
   (e.approval_id=a.id and e.pix_id=r.pix_id and e.amount_usdt=r.amount_usdt and e.wallet_address=r.wallet_address
    and e.provider_customer_id=r.provider_customer_id and e.provider_wallet_id=r.provider_wallet_id
    and e.funding_transfer_id=r.provider_transfer_id) as execution_matches
   from peragus_customer_withdrawal_requests r
   left join peragus_customer_purchase_intents p on p.id=r.purchase_intent_id and p.customer_id=r.customer_id and p.environment='test'
   left join peragus_customer_sandbox_pix x on x.id=r.pix_id and x.customer_id=r.customer_id and x.environment='test'
   left join peragus_withdrawal_operator_approvals a on a.withdrawal_request_id=r.id and a.customer_id=r.customer_id and a.environment='test'
   left join peragus_sandbox_withdrawal_executions e on e.withdrawal_request_id=r.id and e.customer_id=r.customer_id and e.environment='test'
   left join peragus_customer_refund_requests rf on rf.purchase_intent_id=r.purchase_intent_id and rf.customer_id=r.customer_id and rf.environment='test'
   left join peragus_manual_refund_decisions rd on rd.refund_request_id=rf.id and rd.customer_id=r.customer_id
   left join peragus_manual_refund_completions rc on rc.refund_request_id=rf.id and rc.customer_id=r.customer_id
   where r.id=$1 and r.environment='test' `,[id]);
  const r=result.rows[0];if(!r)throw new OperatorAuditNotFound();
  const conversionCompleted=completed(r.pix_status,r.pix_source_status,r.pix_destination_status);
  const convertedAmount=conversionCompleted?positive(r.pix_converted_amount):null;
  const sendCompleted=completed(r.execution_status,r.execution_source_status,r.execution_destination_status);
  const convertedMatches=convertedAmount!==null && units(convertedAmount)===units(r.amount_usdt);
  return {
   withdrawal_request_id:r.id,customer_id:r.customer_id,recorded_at:iso(r.created_at),environment:"test",real_money:false,
   refund_request:r.refund_id?{id:r.refund_id,state:r.refund_state}:null,
   source:{currency:"USDT",gross_amount:r.amount_usdt},
   destination:{wallet_address:r.wallet_address,network:"solana",proof_network:"solana:devnet",verified_at:iso(r.wallet_verified_at)},
   purchase:r.purchase_id?{id:r.purchase_id,recorded_at:iso(r.purchase_created_at),source:{currency:"BRL",amount:r.source_amount_brl},estimated_target:{currency:"USDT",amount:r.estimated_target_amount_usdt,indicative:true}}:null,
   pix:r.pix_id?{id:r.pix_id,recorded_at:iso(r.pix_created_at),last_updated_at:iso(r.pix_updated_at),creation_attempted:r.pix_attempted===true,
    state:r.pix_status??(r.pix_attempted?"uncertain":"reserved"),source_leg_status:r.pix_source_status,destination_leg_status:r.pix_destination_status,
    conversion_completed:conversionCompleted,converted_target_amount:convertedAmount}:null,
   approval:r.approval_id?{id:r.approval_id,recorded_at:iso(r.approved_at),operator_user_id:r.operator_id,reason:r.reason,assurance_level:"aal2",record_only:true}:null,
   execution:r.execution_id?{id:r.execution_id,recorded_at:iso(r.execution_created_at),last_updated_at:iso(r.execution_updated_at),
    state:r.execution_status?`provider_${r.execution_status}`:r.attempted?"uncertain":"reserved",withdrawal_started:r.attempted===true,
    provider_completed:sendCompleted,source_leg_status:r.execution_source_status,destination_leg_status:r.execution_destination_status,
    provider_target_amount:sendCompleted?positive(r.target_amount):null,recovery_required:r.attempted===true && r.execution_status===null,pilot_slot_held:r.pilot_slot_held===true}:null,
   integrity:{purchase_matches:r.purchase_matches===true,pix_matches:r.pix_matches===true,
    converted_amount_matches:convertedMatches,approval_matches:r.approval_id?r.approval_matches===true:null,
    execution_matches:r.execution_id?r.execution_matches===true:null},
   current_eligibility_evaluated:false,observation_freshness:"not_evaluated",execution_authorized:false,
   fee_breakdown:null,onchain_delivery_verified:false,mainnet_execution:false
  };
 }
}
