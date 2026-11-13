import type {Pool,PoolClient} from "pg";
import type {FastifyReply} from "fastify";
import {z} from "zod";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {authorizeWithdrawalOperator,defaultOperatorMfaPolicy,requireFreshMfa,type OperatorMfaPolicy} from "../withdrawals/operator-approvals.js";
import {assertPreviousDayReviewed,DailyReviewRequiredError} from "./daily-review.js";

/**
 * Runtime kill switches (migration 054). Independent of each other and of the env flags
 * (both must allow):
 *  - new_operations: quote create, purchase accept, Pix create;
 *  - usdt_sends: the withdrawal send claim (approval stays allowed);
 *  - onboarding: registration submission and verification start.
 * A pause never cancels or moves an operation. Reconciliation/progression, refund
 * decisions/completions and reads are never gated.
 */
export const RUNTIME_CONTROL_KEYS=["new_operations","usdt_sends","onboarding"] as const;
export type RuntimeControlKey=(typeof RUNTIME_CONTROL_KEYS)[number];
export const runtimeControlKey=z.enum(RUNTIME_CONTROL_KEYS);
/** Operator reason for a change: 1-500 characters, no control characters. */
export const runtimeControlReason=z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/);

export class OperationsPausedError extends Error {
 readonly code="OPERATIONS_PAUSED" as const;
 constructor(readonly key:RuntimeControlKey){super("OPERATIONS_PAUSED");}
}
export class RuntimeControlError extends Error {constructor(readonly code:string){super(code);}}

/**
 * Refuses (OPERATIONS_PAUSED) unless `key` is enabled for the recorded database
 * environment. Runs on the caller's open transaction: the `for share` row lock makes a
 * concurrent switch change wait until the guarded claim/insert commits or rolls back.
 * A database without a recorded environment, or a missing row, reads as paused.
 * new_operations is also gated by the daily review (Task 17): on the same transaction,
 * assertPreviousDayReviewed refuses with DAILY_REVIEW_REQUIRED when the previous São
 * Paulo day had operation activity and no review. Every new_operations call site (quote
 * claim, purchase accept, Pix reserve/claim) therefore runs both checks.
 */
export async function assertControlEnabled(client:Pick<PoolClient,"query">,key:RuntimeControlKey):Promise<void>{
 if(!RUNTIME_CONTROL_KEYS.includes(key))throw new RuntimeControlError("RUNTIME_CONTROL_KEY_INVALID");
 const r=await client.query<{enabled:boolean}>(`select c.enabled from peragus_runtime_controls c
  join peragus_database_environment d on d.singleton and d.environment=c.environment
  where c.key=$1 for share of c`,[key]);
 if(r.rows[0]?.enabled!==true)throw new OperationsPausedError(key);
 if(key==="new_operations")await assertPreviousDayReviewed(client);
}

/**
 * Runs `work` in one READ COMMITTED transaction that first asserts `key`
 * (assertControlEnabled on the same connection). A failed rollback keeps the original
 * error and releases the connection as broken so the pool discards it.
 */
export async function inControlledTransaction<T>(pool:Pick<Pool,"connect">,key:RuntimeControlKey,work:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect();let broken:Error|undefined;
 try{
  await client.query("begin isolation level read committed");
  await assertControlEnabled(client,key);
  const result=await work(client);
  await client.query("commit");
  return result;
 }catch(error){
  try{await client.query("rollback");}catch(rollbackError){broken=rollbackError instanceof Error?rollbackError:new Error("ROLLBACK_FAILED");}
  throw error;
 }finally{client.release(broken);}
}

/**
 * Answers a paused action with 503 OPERATIONS_PAUSED naming the switch, or a missing daily
 * review with 503 DAILY_REVIEW_REQUIRED naming the day; false for any other error.
 */
export function replyIfPaused(error:unknown,reply:FastifyReply):boolean{
 if(error instanceof DailyReviewRequiredError){
  void reply.code(503).send({error:{code:"DAILY_REVIEW_REQUIRED",day:error.day,automatic_retry:false}});
  return true;
 }
 if(!(error instanceof OperationsPausedError))return false;
 void reply.code(503).send({error:{code:"OPERATIONS_PAUSED",key:error.key,automatic_retry:false}});
 return true;
}

interface ControlRow {key:RuntimeControlKey;enabled:boolean;updated_by:string|null;updated_at:Date|string}
const view=(r:ControlRow,mode:MoneyMode)=>({key:r.key,enabled:r.enabled,updated_by:r.updated_by,
 updated_at:new Date(r.updated_at).toISOString(),environment:mode});

/** GET/PUT /v1/admin/runtime-controls: operator allowlist + fresh MFA, every change audited. */
export class RuntimeControlService {
 private readonly e:RowEnvironment;
 private readonly policy:OperatorMfaPolicy;
 constructor(private readonly pool:Pick<Pool,"query"|"connect">,private readonly operators:ReadonlySet<string>,mode:MoneyMode,policy:Partial<OperatorMfaPolicy>={}){
  this.e=rowEnvironment(mode);this.policy=defaultOperatorMfaPolicy(policy);
 }
 authorize(user:AuthenticatedUser){
  authorizeWithdrawalOperator(user,this.operators);
  requireFreshMfa(user,this.policy.mfaMaxAgeSeconds,this.policy.now()/1000);
 }
 async list(user:AuthenticatedUser){
  this.authorize(user);
  const r=await this.pool.query<ControlRow>(`select key,enabled,updated_by,updated_at from peragus_runtime_controls where environment='${this.e.mode}'`);
  const rows=new Map(r.rows.map(row=>[row.key,row]));
  // A missing row reads as paused, like assertControlEnabled.
  return{environment:this.e.mode,controls:RUNTIME_CONTROL_KEYS.map(key=>{
   const row=rows.get(key);
   return row?view(row,this.e.mode):{key,enabled:false,updated_by:null,updated_at:null,environment:this.e.mode};
  })};
 }
 async set(user:AuthenticatedUser,key:RuntimeControlKey,enabled:boolean,reason:string){
  this.authorize(user);
  const parsedKey=runtimeControlKey.parse(key),parsedReason=runtimeControlReason.parse(reason);
  if(typeof enabled!=="boolean")throw new RuntimeControlError("RUNTIME_CONTROL_INPUT_INVALID");
  const client=await this.pool.connect();let broken:Error|undefined;
  try{
   await client.query("begin isolation level read committed");
   // A customer account is never an operator (account separation).
   const owner=await client.query("select 1 from peragus_customers where owner_user_id=$1 limit 1",[user.id]);
   if(owner.rows[0])throw new RuntimeControlError("OPERATOR_ACCOUNT_SEPARATION_REQUIRED");
   const current=await client.query<ControlRow>(`select key,enabled,updated_by,updated_at from peragus_runtime_controls
    where key=$1 and environment='${this.e.mode}' for update`,[parsedKey]);
   const row=current.rows[0];
   if(!row)throw new RuntimeControlError("RUNTIME_CONTROL_NOT_FOUND");
   if(row.enabled===enabled){await client.query("commit");return{...view(row,this.e.mode),changed:false};}
   const updated=await client.query<ControlRow>(`update peragus_runtime_controls set enabled=$2,updated_by=$3,updated_at=now()
    where key=$1 and environment='${this.e.mode}' returning key,enabled,updated_by,updated_at`,[parsedKey,enabled,user.id]);
   await client.query(`insert into peragus_runtime_control_events(key,from_enabled,to_enabled,operator_user_id,reason,environment)
    values($1,$2,$3,$4,$5,'${this.e.mode}')`,[parsedKey,row.enabled,enabled,user.id,parsedReason]);
   await client.query("commit");
   return{...view(updated.rows[0]!,this.e.mode),changed:true};
  }catch(error){
   try{await client.query("rollback");}catch(rollbackError){broken=rollbackError instanceof Error?rollbackError:new Error("ROLLBACK_FAILED");}
   throw error;
  }finally{client.release(broken);}
 }
}
