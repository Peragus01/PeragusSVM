import {moneyNetworkFor,type MoneyMode} from "../config/money-environment.js";
import {z} from "zod";
import type {AuthenticatedUser} from "../auth/customer-access.js";
export class OperatorApprovalError extends Error {
 constructor(public readonly code:string){super(code);}
}
export function authorizeWithdrawalOperator(user:AuthenticatedUser,operators:ReadonlySet<string>){
 if(!operators.has(user.id.toLowerCase()))throw new OperatorApprovalError("WITHDRAWAL_OPERATOR_REQUIRED");
 if(user.assuranceLevel!=="aal2")throw new OperatorApprovalError("WITHDRAWAL_OPERATOR_MFA_REQUIRED");
}
/** Binding default: a money-moving operator action needs a TOTP verified at most 300 s ago. */
export const OPERATOR_MFA_MAX_AGE_SECONDS=300;
// Tolerated clock skew between the Auth server and this process.
const MFA_FUTURE_SKEW_SECONDS=60;
/**
 * Refuses (OPERATOR_MFA_STALE) unless the verified token carries a TOTP verification
 * (amr totp, epoch seconds) at most `maxAgeSeconds` old. Used for withdrawal approval
 * and execution, the operator refund decision and refund completion.
 */
export function requireFreshMfa(user:AuthenticatedUser,maxAgeSeconds:number,now:number=Date.now()/1000):void{
 const at=user.mfaVerifiedAt;
 if(user.assuranceLevel!=="aal2" || typeof at!=="number" || !Number.isFinite(at) || !Number.isFinite(maxAgeSeconds)
  || at>now+MFA_FUTURE_SKEW_SECONDS || now-at>maxAgeSeconds)throw new OperatorApprovalError("OPERATOR_MFA_STALE");
}
export interface OperatorMfaPolicy {mfaMaxAgeSeconds:number;/** Epoch milliseconds. */now:()=>number}
export const defaultOperatorMfaPolicy=(policy:Partial<OperatorMfaPolicy>={}):OperatorMfaPolicy=>({mfaMaxAgeSeconds:OPERATOR_MFA_MAX_AGE_SECONDS,now:()=>Date.now(),...policy});
export function parseWithdrawalOperators(input:string):string[]{
 return z.array(z.string().uuid()).max(5).parse(input.split(",").map(v=>v.trim().toLowerCase()).filter(Boolean));
}
export interface OperatorApproval {
 id:string;withdrawalId:string;customerId:string;operatorId:string;requestId:string;reason:string;
 amountUsdt:string;walletAddress:string;createdAt:string;executionAttempted?:boolean;
}
export interface OperatorApprovalRepository {
 read(withdrawalId:string):Promise<OperatorApproval|null>;
 record(withdrawalId:string,operatorId:string,requestId:string,reason:string):Promise<{record:OperatorApproval;replayed:boolean}>;
}
const renderView=(r:OperatorApproval,mode:MoneyMode)=>({id:r.id,withdrawal_request_id:r.withdrawalId,request_id:r.requestId,
 operator_user_id:r.operatorId,reason:r.reason,created_at:r.createdAt,
 source:{currency:"USDT",amount:r.amountUsdt},destination:{wallet_address:r.walletAddress,proof_network:moneyNetworkFor(mode)},
 approved:true,environment:mode,record_only:true,execution_authorized:false,
 provider_freshness_evaluated:false,balance_reserved:false,withdrawal_started:r.executionAttempted===true,job_enqueued:false});
export class WithdrawalOperatorApprovalService {
 private readonly policy:OperatorMfaPolicy;
 constructor(private readonly repository:OperatorApprovalRepository,private readonly operators:ReadonlySet<string>,private readonly mode:MoneyMode="test",policy:Partial<OperatorMfaPolicy>={}){
  this.policy=defaultOperatorMfaPolicy(policy);
 }
 private view(r:OperatorApproval){return renderView(r,this.mode);}
 isAllowed(id:string){return this.operators.has(id.toLowerCase());}
 authorize(user:AuthenticatedUser){
  authorizeWithdrawalOperator(user,this.operators);
 }
 async read(user:AuthenticatedUser,withdrawalId:string){this.authorize(user);const row=await this.repository.read(withdrawalId);if(!row)throw new OperatorApprovalError("WITHDRAWAL_APPROVAL_NOT_FOUND");return this.view(row);}
 /**
  * Records the approval and moves the operation awaiting_approval -> approved in one
  * transaction under the purchase row lock (ruling 23); requires a fresh TOTP.
  */
 async approve(user:AuthenticatedUser,withdrawalId:string,requestId:string,reason:string){
  this.authorize(user);requireFreshMfa(user,this.policy.mfaMaxAgeSeconds,this.policy.now()/1000);const result=await this.repository.record(withdrawalId,user.id,requestId,reason);return{data:this.view(result.record),replayed:result.replayed};
 }
}
