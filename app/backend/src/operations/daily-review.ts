import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {authorizeWithdrawalOperator,defaultOperatorMfaPolicy,requireFreshMfa,type OperatorMfaPolicy} from "../withdrawals/operator-approvals.js";

/** Calendar days for the daily review are counted in this zone (Brazil, no DST since 2019). */
export const DAILY_REVIEW_TIME_ZONE="America/Sao_Paulo";

export class DailyReviewRequiredError extends Error {
 readonly code="DAILY_REVIEW_REQUIRED" as const;
 constructor(readonly day:string){super("DAILY_REVIEW_REQUIRED");}
}
export class DailyReviewError extends Error {constructor(readonly code:string){super(code);}}

/**
 * SQL predicate: the operation status log of `environment` has activity on `day`
 * (a São Paulo calendar day). The migration 045 backfill is not activity.
 */
export const dayActivitySql=(environment:string,day:string)=>`exists(select 1 from peragus_operation_status_events a
 where a.environment=${environment} and a.actor<>'system:migration_045'
  and a.created_at>=(${day})::timestamp at time zone '${DAILY_REVIEW_TIME_ZONE}'
  and a.created_at<((${day})+1)::timestamp at time zone '${DAILY_REVIEW_TIME_ZONE}')`;

/**
 * Refuses (DAILY_REVIEW_REQUIRED) a new operation when the previous São Paulo calendar
 * day had operation activity in the recorded database environment and no daily review.
 * Runs on the caller's open transaction, right after assertControlEnabled(client,
 * "new_operations"). `now` defaults to the database clock. Never used by reconciliation,
 * refunds, sends of already-approved operations or reads.
 */
export async function assertPreviousDayReviewed(client:Pick<PoolClient,"query">,now?:Date):Promise<void>{
 const r=await client.query<{day:string;active:boolean;reviewed:boolean}>(`with d as (
   select (((coalesce($1::timestamptz,now())) at time zone '${DAILY_REVIEW_TIME_ZONE}')::date-1) as day,e.environment
   from peragus_database_environment e where e.singleton
  ) select d.day::text as day,${dayActivitySql("d.environment","d.day")} as active,
   exists(select 1 from peragus_daily_reviews v where v.day=d.day and v.environment=d.environment) as reviewed
  from d`,[now?now.toISOString():null]);
 const row=r.rows[0];
 if(row?.active===true && row.reviewed!==true)throw new DailyReviewRequiredError(row.day);
}

export const dailyReviewInput=z.object({
 day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 note:z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
}).strict();

interface ReviewRow {day:string;reviewed_by:string;reviewed_at:Date|string;note:string|null}
const view=(r:ReviewRow,mode:MoneyMode)=>({day:r.day,reviewed_by:r.reviewed_by,reviewed_at:new Date(r.reviewed_at).toISOString(),note:r.note,environment:mode});

/** POST /v1/admin/daily-reviews: operator allowlist + fresh MFA; the review row is the audit. */
export class DailyReviewService {
 private readonly e:RowEnvironment;
 private readonly policy:OperatorMfaPolicy;
 constructor(private readonly pool:Pick<Pool,"query">,private readonly operators:ReadonlySet<string>,mode:MoneyMode,policy:Partial<OperatorMfaPolicy>={}){
  this.e=rowEnvironment(mode);this.policy=defaultOperatorMfaPolicy(policy);
 }
 authorize(user:AuthenticatedUser){
  authorizeWithdrawalOperator(user,this.operators);
  requireFreshMfa(user,this.policy.mfaMaxAgeSeconds,this.policy.now()/1000);
 }
 /** Records the review of `day` (today or earlier, São Paulo). Idempotent per day. */
 async review(user:AuthenticatedUser,day:string,note?:string){
  this.authorize(user);
  const input=dailyReviewInput.safeParse({day,...(note===undefined?{}:{note})});
  if(!input.success)throw new DailyReviewError("VALIDATION_ERROR");
  const parsed=new Date(`${input.data.day}T00:00:00Z`);
  if(Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10)!==input.data.day)throw new DailyReviewError("DAILY_REVIEW_DAY_INVALID");
  // Only a day that has started (São Paulo) can be reviewed.
  const valid=await this.pool.query<{ok:boolean}>(`select $1::date<=(now() at time zone '${DAILY_REVIEW_TIME_ZONE}')::date and $1::date>=date '2026-01-01' as ok`,[input.data.day]);
  if(valid.rows[0]?.ok!==true)throw new DailyReviewError("DAILY_REVIEW_DAY_INVALID");
  // A customer account is never an operator (account separation).
  const owner=await this.pool.query("select 1 from peragus_customers where owner_user_id=$1 limit 1",[user.id]);
  if(owner.rows[0])throw new DailyReviewError("OPERATOR_ACCOUNT_SEPARATION_REQUIRED");
  const inserted=await this.pool.query<ReviewRow>(`insert into peragus_daily_reviews(day,environment,reviewed_by,note)
   values($1::date,'${this.e.mode}',$2,$3) on conflict (day,environment) do nothing returning day::text as day,reviewed_by,reviewed_at,note`,
   [input.data.day,user.id,input.data.note??null]);
  if(inserted.rows[0])return{...view(inserted.rows[0],this.e.mode),changed:true};
  const prior=await this.pool.query<ReviewRow>(`select day::text as day,reviewed_by,reviewed_at,note from peragus_daily_reviews
   where day=$1::date and environment='${this.e.mode}'`,[input.data.day]);
  return{...view(prior.rows[0]!,this.e.mode),changed:false};
 }
}
