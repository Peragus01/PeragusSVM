import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import type {PgBoss} from "pg-boss";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {moneyModeFor,providerKeyMatchesMode,type MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import {authorizeWithdrawalOperator} from "../withdrawals/operator-approvals.js";
import {assertSmokeTestSafety} from "./worker-smoke-test.js";
import {z} from "zod";

export class CustomerReconciliationInputError extends Error {}
export const CUSTOMER_RECONCILIATION_QUEUE="customer-sandbox-reconciliation";
interface Checkpoint {
 id:string;customer_id:string;purchase_intent_id:string;pix_id:string|null;withdrawal_request_id:string|null;
 attempts:number;lease_token:string;first_attempt_at:Date|string;created_at:Date|string;
}
export interface PollResult {status:string;complete:boolean;review:boolean;}
export interface CustomerReconciliationReader {
 pix(customerId:string,id:string):Promise<PollResult>;
 withdrawal(customerId:string,id:string):Promise<PollResult>;
}
/**
 * Reads only (GET) plus local progression. Test mode stays pinned to the staging
 * database; live (PERAGUS_DEPLOYMENT_ENV=production) runs against its own database.
 * Either way the key must belong to the configured money mode and every
 * financial/demo write flag must be off.
 */
export function assertCustomerReconciliationSafety(env:Parameters<typeof assertSmokeTestSafety>[0]&{DATABASE_SSL:boolean;OZAV_API_KEY?:string|undefined;PERAGUS_DEPLOYMENT_ENV?:string|undefined}){
 const mode=moneyModeFor({PERAGUS_DEPLOYMENT_ENV:env.PERAGUS_DEPLOYMENT_ENV} as Parameters<typeof moneyModeFor>[0]);
 if(mode==="test")assertSmokeTestSafety(env);
 else if(env.OZAV_ONRAMP_WRITES_ENABLED || env.OZAV_OFFRAMP_WRITES_ENABLED || env.SOLANA_COSIGNING_ENABLED
  || env.SOLANA_CONTINGENCY_RESERVE_ENABLED || env.PERAGUS_SANDBOX_DEMO_ENABLED)
  throw new Error("Customer reconciliation requires all financial and demo flags disabled");
 if(!env.DATABASE_SSL || !providerKeyMatchesMode(env.OZAV_API_KEY,mode))
  throw new Error("Customer reconciliation requires SSL and a provider key for the money mode");
}
const statuses=new Set(["awaiting_payment","payment_confirmed","converting","payout_initiated","completed","failed","cancelled","expired","needs_review","awaiting_approval","uncertain","reserved"]);
function classifyError(error:unknown){
 const code=error && typeof error==="object" && "code" in error?String(error.code):"";
 if(code.includes("CONTEXT_MISMATCH") || code.includes("BINDING_CONFLICT"))return "EVIDENCE_MISMATCH";
 if(code.endsWith("NOT_FOUND"))return "RESOURCE_NOT_FOUND";
 if(code.includes("CONFLICT"))return "OBSERVATION_CONFLICT";
 return "PROVIDER_READ_UNAVAILABLE";
}

/**
 * Minutes until the next GET of a pending checkpoint: 1 for the first 15 attempts, 5 up to 45,
 * then 15 (the 120 attempts then cover about 21 h, inside the 24 h commitment).
 */
export const backoffMinutes=(attempts:number)=>attempts<15?1:attempts<45?5:15;
/** Discovers existing requests only. Every provider call is a read, never a retry of a send. */
export class CustomerReconciliationService {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pick<Pool,"query">,private readonly reader:CustomerReconciliationReader,mode:MoneyMode){this.e=rowEnvironment(mode);}
 async discover(){
  await this.pool.query(`insert into peragus_customer_reconciliation(customer_id,purchase_intent_id,pix_id,created_at,environment)
   select x.customer_id,x.purchase_intent_id,x.id,x.created_at,'${this.e.mode}' from peragus_customer_sandbox_pix x
   where x.environment='${this.e.mode}' and x.create_attempted
    and not exists(select 1 from peragus_customer_reconciliation c where c.pix_id=x.id)
   order by x.created_at,x.id limit 100 on conflict do nothing`);
  await this.pool.query(`insert into peragus_customer_reconciliation(customer_id,purchase_intent_id,withdrawal_request_id,created_at,environment)
   select e.customer_id,w.purchase_intent_id,e.withdrawal_request_id,e.created_at,'${this.e.mode}' from peragus_sandbox_withdrawal_executions e
   join peragus_customer_withdrawal_requests w on w.id=e.withdrawal_request_id and w.customer_id=e.customer_id and w.environment='${this.e.mode}'
   where e.environment='${this.e.mode}' and e.create_attempted
    and not exists(select 1 from peragus_customer_reconciliation c where c.withdrawal_request_id=e.withdrawal_request_id)
   order by e.created_at,e.id limit 100 on conflict do nothing`);
 }
 async run(){
  await this.discover();
  // If a worker died on its final lease, persist the unresolved terminal checkpoint.
  await this.pool.query(`with exhausted as (
   update peragus_customer_reconciliation set state='needs_review',manual_review_required=true,
    last_error_code='ATTEMPTS_EXHAUSTED',lease_token=null,lease_until=null,updated_at=now()
   where state='pending' and attempts>=120 and (lease_until is null or lease_until<=now()) returning *
  ) insert into peragus_customer_reconciliation_events(reconciliation_id,attempt,state,provider_status,error_code,manual_review_required)
   select id,attempts,state,last_status,last_error_code,manual_review_required from exhausted on conflict do nothing`);
  const claim=await this.pool.query<Checkpoint>(`with due as (
   select id from peragus_customer_reconciliation where environment='${this.e.mode}' and state='pending' and attempts<120
    and next_check_at<=now() and (lease_until is null or lease_until<=now())
   order by next_check_at,id for update skip locked limit 1
  ) update peragus_customer_reconciliation c set lease_token=$1,lease_until=now()+interval '10 minutes',
   attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),updated_at=now()
   from due where c.id=due.id returning c.*`,[randomUUID()]);
  const row=claim.rows[0];if(!row)return {processed:false as const};
  let result:PollResult|null=null,errorCode:string|null=null;
  try {
   result=row.pix_id?await this.reader.pix(row.customer_id,row.pix_id):await this.reader.withdrawal(row.customer_id,row.withdrawal_request_id!);
   if(!statuses.has(result.status))throw Error("Unexpected provider status");
  }catch(error){result=null;errorCode=classifyError(error);}
  const unresolved=result===null || (!result.complete && !result.review);
  const exhausted=row.attempts>=120 && unresolved;
  const permanent=errorCode==="EVIDENCE_MISMATCH" || errorCode==="RESOURCE_NOT_FOUND";
  const state=permanent || result?.review || exhausted?"needs_review":result?.complete?"provider_terminal":"pending";
  const aged=Date.now()-new Date(row.created_at).getTime()>=15*60*1000;
  // An ordinary unpaid Pix is not a mismatch (final review I6): only a send left unresolved is
  // flagged by age; a Pix is flagged only when the checkpoint itself needs review.
  const review=state==="needs_review" || (unresolved && aged && !row.pix_id);
  if(exhausted)errorCode="ATTEMPTS_EXHAUSTED";
  const saved=await this.pool.query<{id:string}>(`with saved as (
   update peragus_customer_reconciliation set state=$3,last_status=$4,last_error_code=$5,
    manual_review_required=$6,last_checked_at=now(),next_check_at=now()+make_interval(mins=>$7),
    lease_token=null,lease_until=null,updated_at=now()
   where id=$1 and lease_token=$2 returning *
  ) insert into peragus_customer_reconciliation_events(reconciliation_id,attempt,state,provider_status,error_code,manual_review_required)
   select id,attempts,state,last_status,last_error_code,manual_review_required from saved
   on conflict do nothing returning reconciliation_id as id`,[row.id,row.lease_token,state,result?.status??null,errorCode,review,backoffMinutes(row.attempts)]);
  return {processed:true as const,checkpointId:row.id,kind:row.pix_id?"pix":"withdrawal",state,
   attempts:row.attempts,manualReviewRequired:review,saved:saved.rows.length===1,errorCode};
 }
}

/** Safe operational view; no provider identifiers, secrets or payloads. */
export class CustomerReconciliationStatusService {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pick<Pool,"query">,private readonly operators:ReadonlySet<string>,mode:MoneyMode){this.e=rowEnvironment(mode);}
 async list(user:AuthenticatedUser,query:unknown){
  authorizeWithdrawalOperator(user,this.operators);
  const parsed=z.object({state:z.enum(["all","pending","provider_terminal","needs_review"]).default("all"),
   limit:z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).default("20")}).strict().safeParse(query);
  if(!parsed.success)throw new CustomerReconciliationInputError();
  const rows=await this.pool.query(`select id,purchase_intent_id,pix_id,withdrawal_request_id,state,attempts,
   last_status,last_error_code,manual_review_required,last_checked_at,
   case when state='pending' then next_check_at end as next_check_at,updated_at,
   coalesce(lease_until>now(),false) as leased from peragus_customer_reconciliation
   where environment='${this.e.mode}' and ($1='all' or state=$1)
   order by manual_review_required desc,updated_at desc,id desc limit $2`,[parsed.data.state,Number(parsed.data.limit)]);
  return {data:rows.rows,meta:{environment:this.e.mode,provider_reads_only:true,financial_retries:false}};
 }
}
export async function registerCustomerReconciliationWorker(boss:Pick<PgBoss,"createQueue"|"schedule"|"work">,service:Pick<CustomerReconciliationService,"run">){
 await boss.createQueue(CUSTOMER_RECONCILIATION_QUEUE,{policy:"singleton",retryLimit:0,expireInSeconds:300});
 await boss.schedule(CUSTOMER_RECONCILIATION_QUEUE,"* * * * *",{}, {singletonKey:"customer-reconciliation",retryLimit:0,expireInSeconds:300});
 await boss.work(CUSTOMER_RECONCILIATION_QUEUE,{localConcurrency:1,pollingIntervalSeconds:2},async()=>{
  try{
   const result=await service.run();
   console.info(JSON.stringify({event:"customer_reconciliation_tick",...result}));
   return result;
  }catch{
   console.warn(JSON.stringify({event:"customer_reconciliation_tick_failed",code:"CUSTOMER_RECONCILIATION_UNAVAILABLE"}));
   throw new Error("CUSTOMER_RECONCILIATION_UNAVAILABLE");
  }
 });
}
