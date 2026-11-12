import type {Pool} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {WithdrawalRequestError} from "./customer-withdrawal-requests.js";

interface ResultRow {
  id:string; amount_usdt:string; wallet_address:string; approved:boolean; refused:boolean;
  attempted:boolean; status:string|null; source_status:string|null;
  destination_status:string|null; target_amount:string|null; observed_at:Date|string|null;
}
const units=(value:string)=>{
  if(!/^\d{1,15}(\.\d{1,6})?$/.test(value))return null;
  const [whole,fraction=""]=value.split(".");
  return BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,"0"));
};
const format=(value:bigint)=>`${value/1000000n}.${String(value%1000000n).padStart(6,"0")}`;

/** Stored evidence only: no provider, signer, queue, or mutation dependency. */
export class CustomerWithdrawalResultService {
  private readonly e:RowEnvironment;
  constructor(private readonly pool:Pick<Pool,"query">,mode:MoneyMode){this.e=rowEnvironment(mode);}
  async read(customerId:string,id:string){
    const result=await this.pool.query<ResultRow>(`select r.id,coalesce(e.send_amount_usdt,r.amount_usdt)::text as amount_usdt,r.wallet_address,(e.provider_refusal_code is not null) as refused,
      (a.id is not null) as approved,coalesce(e.create_attempted,false) as attempted,
      e.observation->>'status' as status,
      e.observation->>'sourceLegStatus' as source_status,
      e.observation->>'destinationLegStatus' as destination_status,
      e.observation->>'targetAmount' as target_amount,
      case when e.observation is not null then e.updated_at end as observed_at
      from peragus_customer_withdrawal_requests r
      left join peragus_withdrawal_operator_approvals a
        on a.withdrawal_request_id=r.id and a.customer_id=r.customer_id and a.environment='${this.e.mode}'
      left join peragus_sandbox_withdrawal_executions e
        on e.withdrawal_request_id=r.id and e.customer_id=r.customer_id and e.environment='${this.e.mode}'
      where r.id=$2 and r.customer_id=$1 and r.environment='${this.e.mode}'`,[customerId,id]);
    const row=result.rows[0];
    if(!row)throw new WithdrawalRequestError("WITHDRAWAL_REQUEST_NOT_FOUND");
    const completed=row.status==="completed" && row.source_status==="completed" && row.destination_status==="completed";
    const gross=units(row.amount_usdt),target=row.target_amount==null?null:units(row.target_amount);
    const known=completed && gross!==null && target!==null && target>0n && target<=gross;
    return {
      withdrawal_request_id:row.id,environment:this.e.mode,real_money:this.e.mode==="live",
      state:row.status?`provider_${row.status}`:row.refused?"provider_refused":row.attempted?"uncertain":row.approved?"approved":"recorded",
      approved:row.approved,withdrawal_started:row.attempted,provider_completed:completed,
      recovery_required:row.attempted && row.status===null && !row.refused,
      amounts:{currency:"USDT",gross_amount:row.amount_usdt,
        net_amount:known?format(target!):null,
        deducted_amount:known?format(gross!-target!):null,
        basis:known?"recorded_provider_amounts":"not_reported",
        fee_breakdown:null},
      destination:{wallet_address:row.wallet_address,network:"solana",proof_network:this.e.network},
      observed_at:row.observed_at?new Date(row.observed_at).toISOString():null,
      observation_freshness:"not_evaluated",onchain_delivery_verified:false,mainnet_execution:this.e.mode==="live" && row.attempted
    };
  }
}
