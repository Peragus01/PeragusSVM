import {z} from "zod";
import type {AuthenticatedUser} from "../auth/customer-access.js";
export class OperatorApprovalError extends Error {
 constructor(public readonly code:string){super(code);}
}
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
const view=(r:OperatorApproval)=>({id:r.id,withdrawal_request_id:r.withdrawalId,request_id:r.requestId,
 operator_user_id:r.operatorId,reason:r.reason,created_at:r.createdAt,
 source:{currency:"USDT",amount:r.amountUsdt},destination:{wallet_address:r.walletAddress,proof_network:"solana:devnet"},
 approved:true,environment:"test",record_only:true,execution_authorized:false,
 provider_freshness_evaluated:false,balance_reserved:false,withdrawal_started:r.executionAttempted===true,job_enqueued:false});
export class WithdrawalOperatorApprovalService {
 constructor(private readonly repository:OperatorApprovalRepository,private readonly operators:ReadonlySet<string>){}
 isAllowed(id:string){return this.operators.has(id.toLowerCase());}
 authorize(user:AuthenticatedUser){
  if(!this.isAllowed(user.id))throw new OperatorApprovalError("WITHDRAWAL_OPERATOR_REQUIRED");
  if(user.assuranceLevel!=="aal2")throw new OperatorApprovalError("WITHDRAWAL_OPERATOR_MFA_REQUIRED");
 }
 async read(user:AuthenticatedUser,withdrawalId:string){this.authorize(user);const row=await this.repository.read(withdrawalId);if(!row)throw new OperatorApprovalError("WITHDRAWAL_APPROVAL_NOT_FOUND");return view(row);}
 async approve(user:AuthenticatedUser,withdrawalId:string,requestId:string,reason:string){
  this.authorize(user);const result=await this.repository.record(withdrawalId,user.id,requestId,reason);return{data:view(result.record),replayed:result.replayed};
 }
}
