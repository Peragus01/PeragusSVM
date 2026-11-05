import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {AuthenticatedUser} from '../auth/customer-access.js';
import type {WithdrawalObservation} from '../providers/ozav-sandbox-withdrawal.js';
import {authorizeWithdrawalOperator} from './operator-approvals.js';
import {SandboxExecutionError,validateWithdrawal,type SandboxExecutionRepository} from './sandbox-execution.js';

export class SandboxClosureError extends Error {constructor(public readonly code:string){super(code);}}
interface Row {id:string;execution_id:string;withdrawal_request_id:string;operator_user_id:string;request_id:string;reason:string;amount_usdt:string;closed_at:Date|string;}
const view=(r:Row)=>({id:r.id,execution_id:r.execution_id,withdrawal_request_id:r.withdrawal_request_id,request_id:r.request_id,
 operator_user_id:r.operator_user_id,reason:r.reason,closed_at:new Date(r.closed_at).toISOString(),source:{currency:'USDT',amount:r.amount_usdt},
 environment:'test',pilot_slot_released:true,provider_completion_rechecked:true,execution_authorized:false,real_money:false,onchain_delivery_verified:false,mainnet_execution:false});
const completed=(t:WithdrawalObservation|null)=>t?.status==='completed' && t.sourceLegStatus==='completed' && t.destinationLegStatus==='completed';

/** Only transfer GET capability is accepted. Never reserves, claims or sends. */
export class SandboxClosureService {
 constructor(private readonly pool:Pick<Pool,'query'>,private readonly repository:Pick<SandboxExecutionRepository,'read'>,
  private readonly operators:ReadonlySet<string>,private readonly enabled=false,
  private readonly reader?:{transfer(id:string):Promise<WithdrawalObservation>}){}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.operators);}
 private async find(where:string,args:unknown[]){return (await this.pool.query<Row>(`select * from peragus_sandbox_withdrawal_closures where environment='test' and ${where}`,args)).rows[0];}
 async read(user:AuthenticatedUser,id:string){this.authorize(user);const row=await this.find('withdrawal_request_id=$1',[id]);if(!row)throw new SandboxClosureError('WITHDRAWAL_CLOSURE_NOT_FOUND');return view(row);}
 private replay(row:Row,id:string,key:string,reason:string,userId:string){
  if(row.withdrawal_request_id!==id || row.request_id!==key || row.operator_user_id!==userId || row.reason!==reason)
   throw new SandboxClosureError('WITHDRAWAL_CLOSURE_IDEMPOTENCY_CONFLICT');
  return {data:view(row),replayed:true};
 }
 async close(user:AuthenticatedUser,id:string,key:string,reason:string){
  this.authorize(user);
  if(!this.enabled)throw new SandboxClosureError('SANDBOX_WITHDRAWAL_CLOSURE_DISABLED');
  const prior=await this.find('operator_user_id=$1 and request_id=$2',[user.id,key]);
  if(prior)return this.replay(prior,id,key,reason,user.id);
  if(await this.find('withdrawal_request_id=$1',[id]))throw new SandboxClosureError('WITHDRAWAL_CLOSURE_ALREADY_RECORDED');
  const row=await this.repository.read(id);
  if(!row)throw new SandboxClosureError('WITHDRAWAL_EXECUTION_NOT_FOUND');
  if(row.closedAt || !row.attempted || !row.sendTransferId || !completed(row.observation))throw new SandboxClosureError('WITHDRAWAL_CLOSURE_NOT_READY');
  validateWithdrawal(row,row.observation!);
  if(!this.reader)throw new SandboxClosureError('WITHDRAWAL_CLOSURE_PROVIDER_UNAVAILABLE');
  const fresh=await this.reader.transfer(row.sendTransferId);
  validateWithdrawal(row,fresh);
  if(!completed(fresh))throw new SandboxClosureError('WITHDRAWAL_CLOSURE_NOT_READY');
  try {
   const result=await this.pool.query<Row>(`with locked as (
    select * from peragus_sandbox_withdrawal_executions where id=$1 and withdrawal_request_id=$2 and environment='test'
     and create_attempted and closed_at is null and provider_send_id=$3 and observation=$4::jsonb
     and not exists(select 1 from peragus_customers where owner_user_id=$5) for update
   ), closed as (
    update peragus_sandbox_withdrawal_executions e set closed_at=now(),updated_at=now() from locked l
    where e.id=l.id and e.closed_at is null and e.observation=$4::jsonb returning e.*
   ) insert into peragus_sandbox_withdrawal_closures(id,execution_id,withdrawal_request_id,customer_id,operator_user_id,request_id,reason,amount_usdt,stored_observation,fresh_observation,closed_at)
    select $6,id,withdrawal_request_id,customer_id,$5,$7,$8,amount_usdt,observation,$9::jsonb,closed_at from closed returning *`,
    [row.id,id,row.sendTransferId,JSON.stringify(row.observation),user.id,randomUUID(),key,reason,JSON.stringify(fresh)]);
   if(result.rows[0])return {data:view(result.rows[0]),replayed:false};
  } catch(error){
   if(!(error && typeof error==='object' && 'code' in error && error.code==='23505'))throw error;
  }
  const winner=await this.find('operator_user_id=$1 and request_id=$2',[user.id,key]);
  if(winner)return this.replay(winner,id,key,reason,user.id);
  if(await this.find('withdrawal_request_id=$1',[id]))throw new SandboxClosureError('WITHDRAWAL_CLOSURE_ALREADY_RECORDED');
  throw new SandboxClosureError('WITHDRAWAL_CLOSURE_CONTEXT_CHANGED');
 }
}
