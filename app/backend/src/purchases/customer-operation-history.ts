import type {Pool} from "pg";
import {explorerTxUrl,type MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {z} from "zod";

const uuid=z.string().uuid();
const timestamp=z.iso.datetime({precision:6});
const cursorSchema=z.object({created_at:timestamp,id:uuid}).strict();
export class OperationHistoryInputError extends Error {}
export function parseHistoryQuery(query:unknown){
  const parsed=z.object({limit:z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).optional(),
    cursor:z.string().regex(/^[A-Za-z0-9_-]+$/).max(512).optional()}).strict().safeParse(query);
  if(!parsed.success)throw new OperationHistoryInputError();
  let cursor:z.infer<typeof cursorSchema>|null=null;
  if(parsed.data.cursor){
    try{
      const raw=Buffer.from(parsed.data.cursor,"base64url");
      if(raw.toString("base64url")!==parsed.data.cursor)throw new Error();
      cursor=cursorSchema.parse(JSON.parse(raw.toString("utf8")));
    }catch{throw new OperationHistoryInputError();}
  }
  return {limit:Number(parsed.data.limit??20),cursor};
}
type HistoryOptions=ReturnType<typeof parseHistoryQuery>;
interface Row {
  refund_id:string|null;refund_state:string|null;
  id:string; quote_id:string; created_at:string; source_amount_brl:string;
  estimated_target_amount_usdt:string; wallet_address:string;
  pix_id:string|null; pix_attempted:boolean|null; pix_status:string|null;
  pix_source_status:string|null; pix_destination_status:string|null; converted_amount:string|null;
  withdrawal_id:string|null; approved:boolean; execution_id:string|null; attempted:boolean;
  execution_status:string|null; execution_source_status:string|null; execution_destination_status:string|null;
  execution_refused:boolean; destination_blocker:string|null;
  operation_status:string; delivery_status:string|null; delivered_amount:string|null; tx_hash:string|null;
}
const DESTINATION_BLOCKERS=new Set(["DESTINATION_TOKEN_ACCOUNT_MISSING","DESTINATION_TOKEN_ACCOUNT_FROZEN"]);
const providerStatus=z.enum(["awaiting_payment","payment_confirmed","converting","payout_initiated",
  "completed","failed","cancelled","expired","needs_review","awaiting_approval"]);
function status(value:string|null){const parsed=providerStatus.safeParse(value);return parsed.success?parsed.data:null;}
function positiveAmount(value:string|null){
  if(value===null || !/^\d{1,15}(\.\d{1,6})?$/.test(value))return null;
  const [whole,fraction=""]=value.split(".");
  const units=BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,"0"));
  return units>0n?`${units/1000000n}.${String(units%1000000n).padStart(6,"0")}`:null;
}

/** One read-only query, scoped by authenticated customer at every join. */
export class CustomerOperationHistoryService {
  private readonly e:RowEnvironment;
  constructor(private readonly pool:Pick<Pool,"query">,mode:MoneyMode){this.e=rowEnvironment(mode);}
  async list(customerId:string,options:HistoryOptions){
    return this.read(customerId,options);
  }
  async get(customerId:string,operationId:string){
    const page=await this.read(customerId,{limit:1,cursor:null},operationId);
    return page.data[0]??null;
  }
  private async read(customerId:string,options:HistoryOptions,operationId?:string){
    const {limit,cursor}=options;
    const result=await this.pool.query<Row>(`with page as (
      select p.* from peragus_customer_purchase_intents p
      where p.customer_id=$1 and p.environment='${this.e.mode}'
        and ($5::uuid is null or p.id=$5::uuid)
        and ($2::timestamptz is null or (p.created_at,p.id)<($2::timestamptz,$3::uuid))
      order by p.created_at desc,p.id desc limit $4
    ) select p.id,p.quote_id,
      to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
      p.source_amount_brl,p.estimated_target_amount_usdt,p.wallet_address,
      rf.id as refund_id,case when rc.id is not null then 'refund_recorded' else coalesce(rd.decision,'pending_review') end as refund_state,
      x.id as pix_id,x.create_attempted as pix_attempted,x.observation->>'status' as pix_status,
      x.observation->>'sourceLegStatus' as pix_source_status,
      x.observation->>'destinationLegStatus' as pix_destination_status,
      case when x.observation->'amounts'->'target'->>'currency'='USDT'
        then x.observation->'amounts'->'target'->>'amount' end as converted_amount,
      r.id as withdrawal_id,(a.id is not null) as approved,e.id as execution_id,
      coalesce(e.create_attempted,false) as attempted,e.observation->>'status' as execution_status,
      e.observation->>'sourceLegStatus' as execution_source_status,
      e.observation->>'destinationLegStatus' as execution_destination_status,
      (e.provider_refusal_code is not null) as execution_refused,dc.blocker as destination_blocker,
      p.status as operation_status,e.delivery_status,e.delivered_amount_usdt::text as delivered_amount,e.provider_tx_hash as tx_hash
      from page p
      left join peragus_customer_sandbox_pix x on x.purchase_intent_id=p.id and x.customer_id=p.customer_id and x.environment='${this.e.mode}'
      left join peragus_customer_withdrawal_requests r on r.purchase_intent_id=p.id and r.customer_id=p.customer_id and r.environment='${this.e.mode}'
      left join peragus_withdrawal_operator_approvals a on a.withdrawal_request_id=r.id and a.customer_id=p.customer_id and a.environment='${this.e.mode}'
      left join peragus_sandbox_withdrawal_executions e on e.withdrawal_request_id=r.id and e.customer_id=p.customer_id and e.environment='${this.e.mode}'
      left join peragus_withdrawal_destination_checks dc on dc.withdrawal_request_id=r.id and dc.customer_id=p.customer_id and dc.environment='${this.e.mode}'
      left join peragus_customer_refund_requests rf on rf.purchase_intent_id=p.id and rf.customer_id=p.customer_id and rf.environment='${this.e.mode}'
      left join peragus_manual_refund_decisions rd on rd.refund_request_id=rf.id and rd.customer_id=p.customer_id
      left join peragus_manual_refund_completions rc on rc.refund_request_id=rf.id and rc.customer_id=p.customer_id
      order by p.created_at desc,p.id desc`,[customerId,cursor?.created_at??null,cursor?.id??null,limit+1,operationId??null]);
    const hasMore=result.rows.length>limit;
    const rows=result.rows.slice(0,limit);
    const last=rows.at(-1);
    return {data:rows.map(row=>{
      const pixStatus=status(row.pix_status),sendStatus=status(row.execution_status);
      const converted=pixStatus==="completed" && row.pix_source_status==="completed" && row.pix_destination_status==="completed";
      // Real: the operation is delivered_verified and the finalized transaction matched (Task 11).
      const verified=row.operation_status==="delivered_verified" && row.delivery_status==="verified";
      const simulated=row.delivery_status==="simulated";
      return {
        id:row.id,quote_id:row.quote_id,created_at:row.created_at,environment:this.e.mode,real_money:this.e.mode==="live",
        refund_request:row.refund_id?{id:row.refund_id,state:row.refund_state,request_path:`/v1/me/operations/${row.id}/refund-request`}:null,
        stage:row.withdrawal_id?"withdrawal":row.pix_id?"pix":"purchase_recorded",
        source:{currency:"BRL",amount:row.source_amount_brl},
        estimated_target:{currency:"USDT",amount:row.estimated_target_amount_usdt,indicative:true},
        converted_target:converted && positiveAmount(row.converted_amount)?{currency:"USDT",amount:positiveAmount(row.converted_amount)}:null,
        destination:{wallet_address:row.wallet_address,network:"solana",proof_network:this.e.network},
        pix:row.pix_id?{id:row.pix_id,state:pixStatus??(row.pix_attempted?"uncertain":"reserved"),conversion_completed:converted}:null,
        withdrawal:row.withdrawal_id?{
          id:row.withdrawal_id,approved:row.approved,
          state:sendStatus?`provider_${sendStatus}`:row.execution_refused?"provider_refused":row.attempted?"uncertain":row.execution_id?"reserved":row.approved?"approved":"recorded",
          withdrawal_started:row.attempted,
          provider_completed:sendStatus==="completed" && row.execution_source_status==="completed" && row.execution_destination_status==="completed",
          recovery_required:row.attempted && sendStatus===null && !row.execution_refused,
          // DESTINATION_TOKEN_ACCOUNT_MISSING / _FROZEN: the wallet must hold a usable USDT token account before the send.
          destination_blocker:row.destination_blocker!==null && DESTINATION_BLOCKERS.has(row.destination_blocker)?row.destination_blocker:null,
          result_path:`/v1/me/withdrawal-requests/${row.withdrawal_id}/result`
        }:null,
        // Net USDT credited to the wallet on chain (after the network fee); only once verified.
        delivered_target:verified && positiveAmount(row.delivered_amount)?{currency:"USDT",amount:positiveAmount(row.delivered_amount)}:null,
        // Test sends that are not on devnet are labelled simulated and never count as delivered.
        delivery_simulated:simulated,
        explorer_url:simulated?null:explorerTxUrl(this.e.mode,row.tx_hash),
        observation_freshness:"not_evaluated",onchain_delivery_verified:verified,mainnet_execution:this.e.mode==="live" && row.attempted
      };
    }),meta:{has_more:hasMore,next_cursor:hasMore && last?Buffer.from(JSON.stringify({created_at:last.created_at,id:last.id})).toString("base64url"):null}};
  }
}
