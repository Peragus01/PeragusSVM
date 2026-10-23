import type {Pool} from "pg";
import {z} from "zod";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {parseHistoryQuery,OperationHistoryInputError} from "../purchases/customer-operation-history.js";
import {authorizeWithdrawalOperator} from "./operator-approvals.js";

const filters=z.enum(["pending_approval","approved","reserved","uncertain","processing","completed","needs_review","all"]);
export function parseOperatorQueueQuery(query:unknown){
 const parsed=z.object({state:filters.optional(),limit:z.string().optional(),cursor:z.string().optional()}).strict().safeParse(query);
 if(!parsed.success)throw new OperationHistoryInputError();
 const {state="pending_approval",...pagination}=parsed.data;
 return {...parseHistoryQuery(pagination),state};
}
interface Row {
 id:string;customer_id:string;purchase_intent_id:string;pix_id:string;created_at:string;
 amount_usdt:string;wallet_address:string;approved:boolean;approved_at:Date|string|null;
 attempted:boolean;provider_completed:boolean;queue_state:string;
}
/** Database-only operator discovery. No approval, send, reconcile or slot-release dependency. */
export class OperatorWithdrawalQueueService {
 constructor(private readonly pool:Pick<Pool,"query">,private readonly operators:ReadonlySet<string>){}
 async list(user:AuthenticatedUser,query:unknown){
  authorizeWithdrawalOperator(user,this.operators);
  const {limit,cursor,state}=parseOperatorQueueQuery(query);
  const result=await this.pool.query<Row>(`with queue as (
   select r.id,r.customer_id,r.purchase_intent_id,r.pix_id,r.created_at,r.amount_usdt,r.wallet_address,
    (a.id is not null) as approved,a.created_at as approved_at,
    coalesce(e.create_attempted,false) as attempted,
    coalesce(e.observation->>'status'='completed' and e.observation->>'sourceLegStatus'='completed'
     and e.observation->>'destinationLegStatus'='completed',false) as provider_completed,
    case
     when e.observation->>'status'='completed' and e.observation->>'sourceLegStatus'='completed'
       and e.observation->>'destinationLegStatus'='completed' then 'completed'
     when e.observation->>'status' in ('needs_review','failed','cancelled','expired','completed') then 'needs_review'
     when e.observation is not null then 'processing'
     when e.create_attempted then 'uncertain'
     when e.id is not null then 'reserved'
     when a.id is not null then 'approved'
     else 'pending_approval' end as queue_state
   from peragus_customer_withdrawal_requests r
   left join peragus_withdrawal_operator_approvals a
    on a.withdrawal_request_id=r.id and a.customer_id=r.customer_id and a.environment='test'
   left join peragus_sandbox_withdrawal_executions e
    on e.withdrawal_request_id=r.id and e.customer_id=r.customer_id and e.environment='test'
   where r.environment='test'
  ) select id,customer_id,purchase_intent_id,pix_id,amount_usdt,wallet_address,approved,approved_at,attempted,provider_completed,queue_state,
   to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
   from queue where ($1='all' or queue_state=$1)
    and ($2::timestamptz is null or (created_at,id)<($2::timestamptz,$3::uuid))
   order by queue.created_at desc,id desc limit $4`,[state,cursor?.created_at??null,cursor?.id??null,limit+1]);
  const rows=result.rows.slice(0,limit),last=rows.at(-1),hasMore=result.rows.length>limit;
  return {data:rows.map(row=>({
   id:row.id,customer_id:row.customer_id,purchase_intent_id:row.purchase_intent_id,pix_id:row.pix_id,
   created_at:row.created_at,state:row.queue_state,environment:"test",real_money:false,
   source:{currency:"USDT",amount:row.amount_usdt},
   destination:{wallet_address:row.wallet_address,network:"solana",proof_network:"solana:devnet"},
   approved:row.approved,approval_recorded_at:row.approved_at?new Date(row.approved_at).toISOString():null,
   withdrawal_started:row.attempted,provider_completed:row.provider_completed,
   recovery_required:row.queue_state==="uncertain",manual_review_required:row.queue_state==="needs_review",
   current_eligibility_evaluated:false,observation_freshness:"not_evaluated",
   execution_authorized:false,onchain_delivery_verified:false,mainnet_execution:false
  })),meta:{state,has_more:hasMore,next_cursor:hasMore&&last?Buffer.from(JSON.stringify({created_at:last.created_at,id:last.id})).toString("base64url"):null}};
 }
}
