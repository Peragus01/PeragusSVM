import type {Pool} from "pg";
import type {PgBoss} from "pg-boss";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {dayActivitySql,DAILY_REVIEW_TIME_ZONE} from "../operations/daily-review.js";

export const OPERATOR_NOTIFICATIONS_QUEUE="operator-notifications";
export const STUCK_OPERATIONS_QUEUE="stuck-operations";

/**
 * Time-based alert thresholds (Ruling 31; the published refund policy commits to 24 h,
 * sections 10.2, 14.3 and 19.5). Each fires ONCE per operation and threshold while the
 * operation stays in that status (the dedupe key names the status entry time), however
 * often the scanner runs.
 */
export const STUCK_THRESHOLDS={
 sendingMinutes:30,
 sentUnverifiedMinutes:30,
 needsReview:{warnHours:4,highHours:12},
 refundPending:{warnHours:12,highHours:20},
} as const;

/**
 * Every 5 minutes: derives stuck/overdue operations, the existing high-severity alerts
 * and a missing daily review, and enqueues one e-mail pair per (kind, threshold,
 * resource) through peragus_enqueue_operator_notification (idempotent). Reads stored
 * data only; never calls a provider and never changes an operation.
 */
export class StuckOperationScanner {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pick<Pool,"query">,mode:MoneyMode){this.e=rowEnvironment(mode);}
 async scan(now?:Date):Promise<{enqueued:number}>{
  const env=`'${this.e.mode}'`,t=STUCK_THRESHOLDS;
  // $1: the scan clock (database clock when omitted).
  const entered="to_char(p.status_changed_at at time zone 'UTC','YYYYMMDD\"T\"HH24MISSUS')";
  const r=await this.pool.query<{n:number}>(`with clock as (select coalesce($1::timestamptz,now()) as now),
  pix as (
   select x.purchase_intent_id,least(x.lock_deadline_at,case when x.observation->'source'->'paymentInstructions'->>'expiresAt'
     ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})$'
    then (x.observation->'source'->'paymentInstructions'->>'expiresAt')::timestamptz end) as deadline
   from peragus_customer_sandbox_pix x where x.environment=${env}
  ),
  candidates(kind,severity,dedupe_key,purchase_id,payload) as (
   select 'stuck_operation','high','stuck:sending_30m:'||p.id||':'||${entered},p.id,jsonb_build_object('threshold','sending_30m','status_since',p.status_changed_at)
   from peragus_customer_purchase_intents p,clock where p.environment=${env} and p.status='sending'
    and p.status_changed_at<=clock.now-interval '${t.sendingMinutes} minutes'
   union all
   select 'stuck_operation','high','stuck:sent_30m_unverified:'||p.id||':'||${entered},p.id,jsonb_build_object('threshold','sent_30m_unverified','status_since',p.status_changed_at)
   from peragus_customer_purchase_intents p,clock where p.environment=${env} and p.status='sent'
    and p.status_changed_at<=clock.now-interval '${t.sentUnverifiedMinutes} minutes'
   union all
   select 'stuck_operation','high','stuck:awaiting_pix_expired:'||p.id||':'||${entered},p.id,jsonb_build_object('threshold','awaiting_pix_expired','deadline',x.deadline)
   from peragus_customer_purchase_intents p join pix x on x.purchase_intent_id=p.id,clock
   where p.environment=${env} and p.status='awaiting_pix' and x.deadline<=clock.now
   union all
   select 'needs_review',s.severity,'needs_review:'||s.threshold||':'||p.id||':'||${entered},p.id,jsonb_build_object('threshold',s.threshold,'status_since',p.status_changed_at)
   from peragus_customer_purchase_intents p cross join (values ('${t.needsReview.warnHours}h','warn',${t.needsReview.warnHours}),('${t.needsReview.highHours}h','high',${t.needsReview.highHours})) s(threshold,severity,hours),clock
   where p.environment=${env} and p.status='needs_review' and p.status_changed_at<=clock.now-make_interval(hours=>s.hours)
   union all
   select 'refund_pending',s.severity,'refund_pending:'||s.threshold||':'||p.id||':'||${entered},p.id,jsonb_build_object('threshold',s.threshold,'status_since',p.status_changed_at)
   from peragus_customer_purchase_intents p cross join (values ('${t.refundPending.warnHours}h','warn',${t.refundPending.warnHours}),('${t.refundPending.highHours}h','high',${t.refundPending.highHours})) s(threshold,severity,hours),clock
   where p.environment=${env} and p.status='refund_pending' and p.status_changed_at<=clock.now-make_interval(hours=>s.hours)
   union all
   -- Existing high-severity operator alerts (src/operations/operator-alerts.ts).
   select 'reconciliation_mismatch','high','reconciliation_mismatch:'||c.id,c.purchase_intent_id,jsonb_build_object('resource_id',c.id,'event_at',c.created_at)
   from peragus_customer_reconciliation c where c.environment=${env} and (c.state='needs_review' or c.manual_review_required)
   union all
   select 'withdrawal_refused_transfer_found','high','withdrawal_refused_transfer_found:'||e.id,w.purchase_intent_id,jsonb_build_object('resource_id',e.id,'event_at',e.updated_at)
   from peragus_sandbox_withdrawal_executions e
   join peragus_customer_withdrawal_requests w on w.id=e.withdrawal_request_id and w.customer_id=e.customer_id and w.environment=${env}
   where e.environment=${env} and e.refused_transfer_id is not null
   union all
   select 'pix_open_after_close','high','pix_open_after_close:'||x.id,p.id,jsonb_build_object('resource_id',x.id,'event_at',p.status_changed_at)
   from peragus_customer_sandbox_pix x
   join peragus_customer_purchase_intents p on p.id=x.purchase_intent_id and p.customer_id=x.customer_id
   where x.environment=${env} and p.status in ('failed','expired') and x.observation is not null
    and (x.observation->>'status' in ('awaiting_payment','payment_confirmed','converting','payout_initiated','needs_review','completed')
     or x.observation->>'sourceLegStatus'='completed')
    and not exists(select 1 from peragus_operation_status_events m where m.purchase_id=p.id and m.actor='system:migration_045')
    and not exists(select 1 from peragus_operator_refund_decisions o where o.purchase_id=p.id)
   union all
   -- The previous São Paulo day had operation activity and was not reviewed.
   select 'daily_review_missing','high','daily_review_missing:'||d.day::text,null::uuid,jsonb_build_object('day',d.day::text)
   from (select ((clock.now at time zone '${DAILY_REVIEW_TIME_ZONE}')::date-1) as day from clock) d
   where ${dayActivitySql(env,"d.day")}
    and not exists(select 1 from peragus_daily_reviews v where v.day=d.day and v.environment=${env})
  ) select coalesce(sum(peragus_enqueue_operator_notification(${env},c.kind,c.severity,c.dedupe_key,c.purchase_id,
    case when c.purchase_id is null then '{}'::jsonb else peragus_operator_notification_purchase(c.purchase_id) end||c.payload)),0)::int as n
  from candidates c`,[now?now.toISOString():null]);
  return{enqueued:Number(r.rows[0]?.n??0)};
 }
}

/**
 * Registers the outbox drain (every minute) and the stuck-operation scanner (every 5
 * minutes) as singleton pg-boss schedules without retries (a missed run is the next run).
 */
export async function registerOperatorNotificationJobs(boss:Pick<PgBoss,"createQueue"|"schedule"|"work">,jobs:{
 drain:()=>Promise<Record<string,number>>;scan:()=>Promise<{enqueued:number}>;log?:(event:Record<string,unknown>)=>void}){
 const log=jobs.log??(()=>undefined);
 for(const [queue,cron,run] of [[OPERATOR_NOTIFICATIONS_QUEUE,"* * * * *",jobs.drain],[STUCK_OPERATIONS_QUEUE,"*/5 * * * *",jobs.scan]] as const){
  await boss.createQueue(queue,{policy:"singleton",retryLimit:0,expireInSeconds:240});
  await boss.schedule(queue,cron,{},{singletonKey:queue,retryLimit:0,expireInSeconds:240});
  await boss.work(queue,{localConcurrency:1,pollingIntervalSeconds:5},async()=>{
   // Counts only: never addresses, payloads or provider bodies.
   const result=await run();
   log({event:`${queue}_processed`,...result});
   return result;
  });
 }
}
