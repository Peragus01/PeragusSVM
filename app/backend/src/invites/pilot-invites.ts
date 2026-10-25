import {createHash,randomBytes,randomUUID} from "node:crypto";
import type {Pool} from "pg";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {authorizeWithdrawalOperator} from "../withdrawals/operator-approvals.js";
export class PilotInviteError extends Error {constructor(public readonly code:string){super(code);}}
interface InviteRow {
 id:string;slot:number;target_user_id:string;operator_user_id:string;request_id:string;reason:string;duration_hours:number;
 state:"issued"|"redeemed"|"revoked"|"expired";created_at:Date|string;expires_at:Date|string;
 redeemed_by:string|null;redemption_request_id:string|null;redeemed_at:Date|string|null;
 revoked_by:string|null;revocation_request_id:string|null;revocation_reason:string|null;revoked_at:Date|string|null;
}
interface ProfileRow {id:string;customer_type:"pf"|"pj";display_name:string;verification_status:string;suspended:boolean;}
const hash=(code:string)=>createHash("sha256").update(code).digest("hex");
const iso=(date:Date|string|null)=>date?new Date(date).toISOString():null;
const view=(r:InviteRow)=>({id:r.id,slot:r.slot,target_user_id:r.target_user_id,state:r.state==="issued" && new Date(r.expires_at).getTime()<=Date.now()?"expired":r.state,expires_at:iso(r.expires_at),
 created_at:iso(r.created_at),reason:r.reason,redeemed_at:iso(r.redeemed_at),revoked_at:iso(r.revoked_at),environment:"test"});
const profile=(r:ProfileRow)=>({id:r.id,type:r.customer_type,display_name:r.display_name,verification_status:r.verification_status,suspended:r.suspended,operations_enabled:false});
const duplicate=(error:unknown)=>!!error && typeof error==="object" && "code" in error && error.code==="23505";
function fail(code:string):never{throw new PilotInviteError(code);}

export class PilotInviteService {
 constructor(private readonly pool:Pick<Pool,"query">,private readonly operators:ReadonlySet<string>,private readonly enabled=false){}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.operators);}
 private writable(){if(!this.enabled)fail("PILOT_INVITES_DISABLED");}
 private async throttle(userId:string,action:"issue"|"redeem"|"revoke"){
  const r=await this.pool.query<{hits:number}>(`insert into peragus_pilot_invite_rate_limits(actor_user_id,action,hits) values($1,$2,1)
   on conflict(actor_user_id,action) do update set
    hits=case when peragus_pilot_invite_rate_limits.window_start<=now()-interval '15 minutes' then 1 else least(peragus_pilot_invite_rate_limits.hits+1,11) end,
    window_start=case when peragus_pilot_invite_rate_limits.window_start<=now()-interval '15 minutes' then now() else peragus_pilot_invite_rate_limits.window_start end
   returning hits`,[userId,action]);
  if(Number(r.rows[0]?.hits??11)>10)fail("PILOT_INVITE_RATE_LIMITED");
 }
 private async find(where:string,args:unknown[]){const r=await this.pool.query<InviteRow>(`select * from peragus_pilot_invites where environment='test' and ${where}`,args);return r.rows[0]??null;}
 private replayIssue(row:InviteRow,target:string,hours:number,reason:string){
  if(row.target_user_id!==target || row.duration_hours!==hours || row.reason!==reason)fail("PILOT_INVITE_IDEMPOTENCY_CONFLICT");
  return {data:view(row),code:null,replayed:true};
 }
 async issue(user:AuthenticatedUser,requestId:string,target:string,hours:number,reason:string){
  this.authorize(user);this.writable();target=target.toLowerCase();
  const old=await this.find("operator_user_id=$1 and request_id=$2",[user.id,requestId]);
  if(old)return this.replayIssue(old,target,hours,reason);
  await this.throttle(user.id,"issue");
  if(this.operators.has(target.toLowerCase()))fail("PILOT_OPERATOR_NOT_ELIGIBLE");
  const customer=await this.pool.query("select id from peragus_customers where owner_user_id=$1",[target]);
  if(customer.rows.length)fail("PILOT_CUSTOMER_ALREADY_EXISTS");
  await this.pool.query("update peragus_pilot_invites set state='expired' where state='issued' and expires_at<=now()");
  const code="pginv_"+randomBytes(32).toString("base64url"),id=randomUUID();
  try{
   const inserted=await this.pool.query<InviteRow>(`with available as (
    select s.slot,s.current_invite_id from peragus_pilot_invite_slots s
    left join peragus_pilot_invites i on i.id=s.current_invite_id
    where s.admitted_user_id is null and (s.current_invite_id is null or i.state in ('revoked','expired'))
     and not exists(select 1 from peragus_customers where owner_user_id=$3 or owner_user_id=$2)
    order by s.slot limit 1 for update of s skip locked
   ), claimed as (
    update peragus_pilot_invite_slots s set current_invite_id=$1 from available a
    where s.slot=a.slot and s.admitted_user_id is null and s.current_invite_id is not distinct from a.current_invite_id returning s.slot
   ) insert into peragus_pilot_invites(id,slot,target_user_id,operator_user_id,request_id,code_hash,duration_hours,reason,expires_at)
    select $1,slot,$3,$2,$4,$5,$6,$7,now()+($6::int*interval '1 hour') from claimed returning *`,[id,user.id,target,requestId,hash(code),hours,reason]);
   const row=inserted.rows[0];if(!row)fail("PILOT_CAPACITY_UNAVAILABLE");
   return {data:view(row),code,replayed:false};
  }catch(error){
   if(!duplicate(error))throw error;
   const winner=await this.find("operator_user_id=$1 and request_id=$2",[user.id,requestId]);
   if(winner)return this.replayIssue(winner,target,hours,reason);
   fail("PILOT_USER_ALREADY_INVITED");
  }
 }
 async read(user:AuthenticatedUser,id:string){this.authorize(user);const row=await this.find("id=$1",[id]);if(!row)fail("PILOT_INVITE_NOT_FOUND");return view(row);}
 async revoke(user:AuthenticatedUser,id:string,requestId:string,reason:string){
  this.authorize(user);this.writable();
  const prior=await this.find("revoked_by=$1 and revocation_request_id=$2",[user.id,requestId]);
  if(prior){if(prior.id!==id || prior.revocation_reason!==reason)fail("PILOT_INVITE_IDEMPOTENCY_CONFLICT");return {data:view(prior),replayed:true};}
  await this.throttle(user.id,"revoke");
  try{
   const result=await this.pool.query<InviteRow>(`update peragus_pilot_invites set state='revoked',revoked_by=$2,revocation_request_id=$3,revocation_reason=$4,revoked_at=now()
    where id=$1 and state='issued' and environment='test' and not exists(select 1 from peragus_customers where owner_user_id=$2) returning *`,[id,user.id,requestId,reason]);
   if(result.rows[0])return {data:view(result.rows[0]),replayed:false};
  }catch(error){if(!duplicate(error))throw error;fail("PILOT_INVITE_IDEMPOTENCY_CONFLICT");}
  const current=await this.find("id=$1",[id]);
  if(!current)fail("PILOT_INVITE_NOT_FOUND");
  if(current.revoked_by===user.id && current.revocation_request_id===requestId){
   if(current.revocation_reason!==reason)fail("PILOT_INVITE_IDEMPOTENCY_CONFLICT");return {data:view(current),replayed:true};
  }
  fail("PILOT_INVITE_TERMINAL");
 }
 private async replayRedemption(user:AuthenticatedUser,row:InviteRow,requestId:string,name:string){
  if(row.redemption_request_id!==requestId)fail("PILOT_INVITE_ALREADY_REDEEMED");
  const result=await this.pool.query<ProfileRow>("select * from peragus_customers where owner_user_id=$1",[user.id]);
  const customer=result.rows[0];if(!customer || customer.customer_type!=="pf" || customer.display_name!==name)fail("PILOT_INVITE_IDEMPOTENCY_CONFLICT");
  return {data:{invite_id:row.id,customer:profile(customer),environment:"test"},replayed:true};
 }
 async redeem(user:AuthenticatedUser,requestId:string,code:string,name:string){
  this.writable();if(this.operators.has(user.id.toLowerCase()))fail("PILOT_OPERATOR_NOT_ELIGIBLE");
  await this.throttle(user.id,"redeem");
  const digest=hash(code),prior=await this.find("code_hash=$1 and target_user_id=$2",[digest,user.id]);
  // Wrong code and wrong account have the same public response.
  if(!prior)fail("PILOT_INVITE_NOT_AVAILABLE");
  if(prior.state==="redeemed")return this.replayRedemption(user,prior,requestId,name);
  try{
   const result=await this.pool.query<ProfileRow>(`with eligible as (
    select i.id,i.slot from peragus_pilot_invites i join peragus_pilot_invite_slots s on s.slot=i.slot and s.current_invite_id=i.id
    where i.code_hash=$1 and i.target_user_id=$2 and i.state='issued' and i.expires_at>now() and i.environment='test'
     and s.admitted_user_id is null and not exists(select 1 from peragus_customers where owner_user_id=$2)
    for update of i,s
   ), customer as (
    insert into peragus_customers(id,owner_user_id,customer_type,display_name)
    select $3,$2,'pf',$4 from eligible returning *
   ), redeemed as (
    update peragus_pilot_invites i set state='redeemed',redeemed_by=$2,redemption_request_id=$5,redeemed_at=now()
    from eligible e,customer c where i.id=e.id returning i.id,i.slot
   ), admitted as (
    update peragus_pilot_invite_slots s set admitted_user_id=$2 from redeemed r
    where s.slot=r.slot and s.current_invite_id=r.id and s.admitted_user_id is null returning s.slot
   ) select c.* from customer c,admitted`,[digest,user.id,randomUUID(),name,requestId]);
   if(result.rows[0])return {data:{invite_id:prior.id,customer:profile(result.rows[0]),environment:"test"},replayed:false};
  }catch(error){if(!duplicate(error))throw error;}
  const current=await this.find("code_hash=$1 and target_user_id=$2",[digest,user.id]);
  if(current?.state==="redeemed")return this.replayRedemption(user,current,requestId,name);
  fail("PILOT_INVITE_NOT_AVAILABLE");
 }
}
