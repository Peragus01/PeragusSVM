import type {Pool} from 'pg';
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {z} from 'zod';
import type {AuthenticatedUser} from '../auth/customer-access.js';
import {authorizeWithdrawalOperator} from '../withdrawals/operator-approvals.js';

// operation_review: a purchase operation in needs_review (e.g. live Pix with unknown lock outcome).
// pix_open_after_close: the operation failed/expired but its OZAV transfer is still payable or was
// paid (OZAV offers no transfer cancel endpoint, so an operator must follow it).
const kind=z.enum(['reconciliation_review','reconciliation_stalled','withdrawal_uncertain','withdrawal_review','refund_pending_review','refund_approved','operation_review','pix_open_after_close']);
const cursorSchema=z.object({priority:z.union([z.literal(0),z.literal(1)]),at:z.iso.datetime({precision:6}),id:z.string().uuid(),kind}).strict();
export class OperatorAlertInputError extends Error {}
export function parseAlertQuery(query:unknown){
 const parsed=z.object({
  kind:kind.or(z.literal('all')).default('all'),
  severity:z.enum(['all','high','medium']).default('all'),
  limit:z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).default('20'),
  cursor:z.string().regex(/^[A-Za-z0-9_-]+$/).max(512).optional()
 }).strict().safeParse(query);
 if(!parsed.success)throw new OperatorAlertInputError();
 let cursor:z.infer<typeof cursorSchema>|null=null;
 if(parsed.data.cursor){
  try{
   const raw=Buffer.from(parsed.data.cursor,'base64url');
   if(raw.toString('base64url')!==parsed.data.cursor)throw Error();
   cursor=cursorSchema.parse(JSON.parse(raw.toString('utf8')));
  }catch{throw new OperatorAlertInputError();}
 }
 return {...parsed.data,limit:Number(parsed.data.limit),cursor};
}
interface Row {
 id:string;kind:z.infer<typeof kind>;priority:0|1;recorded_at:string;
 purchase_intent_id:string;pix_id:string|null;withdrawal_request_id:string|null;refund_request_id:string|null;
}

/** Derived stored-data alerts, never calls a provider or changes an operation. */
export class OperatorAlertService {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pick<Pool,'query'>,private readonly operators:ReadonlySet<string>,mode:MoneyMode){this.e=rowEnvironment(mode);}
 async list(user:AuthenticatedUser,query:unknown){
  authorizeWithdrawalOperator(user,this.operators);
  const options=parseAlertQuery(query),cursor=options.cursor;
  const result=await this.pool.query<Row>(`with alerts as (
   select c.id,case when c.state='needs_review' or c.manual_review_required then 'reconciliation_review'
    else 'reconciliation_stalled' end as kind,0 as priority,c.created_at as recorded_at,
    c.purchase_intent_id,c.pix_id,c.withdrawal_request_id,null::uuid as refund_request_id
   from peragus_customer_reconciliation c
   where c.environment='${this.e.mode}' and (c.state='needs_review' or c.manual_review_required or
    (c.state='pending' and c.next_check_at<=now()-interval '15 minutes' and (c.lease_until is null or c.lease_until<=now())))
   union all
   select e.id,
    case when e.observation is null then 'withdrawal_uncertain' else 'withdrawal_review' end,
    0,e.created_at,w.purchase_intent_id,e.pix_id,e.withdrawal_request_id,null::uuid
   from peragus_sandbox_withdrawal_executions e
   join peragus_customer_withdrawal_requests w on w.id=e.withdrawal_request_id and w.customer_id=e.customer_id and w.environment='${this.e.mode}'
   where e.environment='${this.e.mode}' and e.create_attempted and (
    e.observation is null or e.observation->>'status' in ('needs_review','failed','cancelled','expired')
    or (e.observation->>'status'='completed' and (
     e.observation->>'sourceLegStatus' is distinct from 'completed'
     or e.observation->>'destinationLegStatus' is distinct from 'completed')))
   union all
   select r.id,case when d.id is null then 'refund_pending_review' else 'refund_approved' end,
    1,r.created_at,r.purchase_intent_id,r.pix_id,null::uuid,r.id
   from peragus_customer_refund_requests r
   left join peragus_manual_refund_decisions d on d.refund_request_id=r.id and d.customer_id=r.customer_id
   left join peragus_manual_refund_completions f on f.refund_request_id=r.id and f.customer_id=r.customer_id
   where r.environment='${this.e.mode}' and f.id is null and (d.id is null or d.decision='approved')
   union all
   select p.id,'operation_review',0,p.status_changed_at,p.id,x.id,null::uuid,null::uuid
   from peragus_customer_purchase_intents p
   left join peragus_customer_sandbox_pix x on x.purchase_intent_id=p.id and x.customer_id=p.customer_id
   where p.environment='${this.e.mode}' and p.status='needs_review'
   union all
   select x.id,'pix_open_after_close',0,p.status_changed_at,p.id,x.id,null::uuid,null::uuid
   from peragus_customer_sandbox_pix x
   join peragus_customer_purchase_intents p on p.id=x.purchase_intent_id and p.customer_id=x.customer_id
   where x.environment='${this.e.mode}' and p.status in ('failed','expired') and x.observation is not null
    and (x.observation->>'status' in ('awaiting_payment','payment_confirmed','converting','payout_initiated','needs_review')
     or (x.observation->>'status' in ('failed','cancelled','expired') and x.observation->>'sourceLegStatus'='completed'))
    and not exists(select 1 from peragus_operation_status_events m where m.purchase_id=p.id and m.actor='system:migration_045')
  ) select id,kind,priority,
   to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
   purchase_intent_id,pix_id,withdrawal_request_id,refund_request_id
  from alerts where ($1='all' or kind=$1) and ($2='all' or priority=case when $2='high' then 0 else 1 end)
   and ($3::int is null or (priority,recorded_at,id,kind)>($3::int,$4::timestamptz,$5::uuid,$6::text))
  order by priority,recorded_at,id,kind limit $7`,[
   options.kind,options.severity,cursor?.priority??null,cursor?.at??null,cursor?.id??null,cursor?.kind??null,options.limit+1
  ]);
  const rows=result.rows.slice(0,options.limit),hasMore=result.rows.length>options.limit,last=rows.at(-1);
  return {data:rows.map(row=>({
   id:`${row.kind}:${row.id}`,resource_id:row.id,kind:row.kind,severity:row.priority===0?'high':'medium',
   first_recorded_at:row.recorded_at,purchase_intent_id:row.purchase_intent_id,pix_id:row.pix_id,
   withdrawal_request_id:row.withdrawal_request_id,refund_request_id:row.refund_request_id,
   detail_path:row.refund_request_id?`/v1/admin/refund-requests/${row.refund_request_id}`:
    row.kind.startsWith('reconciliation_') || row.kind==='operation_review' || row.kind==='pix_open_after_close'?'/v1/admin/customer-reconciliation':`/v1/admin/withdrawal-requests/${row.withdrawal_request_id}/audit`,
   environment:this.e.mode,stored_evidence_only:true,execution_authorized:false
  })),meta:{has_more:hasMore,next_cursor:hasMore && last?Buffer.from(JSON.stringify({priority:last.priority,at:last.recorded_at,id:last.id,kind:last.kind})).toString('base64url'):null,
   environment:this.e.mode,provider_refreshed:false,notifications_sent:false}};
 }
}
