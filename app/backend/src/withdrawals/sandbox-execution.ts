import {PublicKey} from "@solana/web3.js";
import {validatePixTransfer} from "../purchases/customer-sandbox-pix.js";
import {onboardingExternalRef} from "../onboarding/submission-types.js";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import type {WithdrawalOperatorApprovalService} from "./operator-approvals.js";
import {usdtUnits,type OzavSandboxWithdrawalProvider,type WithdrawalObservation} from "../providers/ozav-sandbox-withdrawal.js";
export class SandboxExecutionError extends Error {constructor(public readonly code:string){super(code);}}
export interface ExecutionContext {
 withdrawalId:string;customerId:string;approvalId:string;approverId:string;pixId:string;
 providerCustomerId:string;providerWalletId:string;providerQuoteId:string;transferId:string;amountBrl:string;
 amountUsdt:string;walletAddress:string;verifiedAt:string;
}
export interface SandboxExecution extends ExecutionContext {
 id:string;operatorId:string;requestId:string;attempted:boolean;sendTransferId:string|null;observation:WithdrawalObservation|null;
 closedAt?:string|null;
}
export interface SandboxExecutionRepository {
 context(withdrawalId:string):Promise<ExecutionContext|null>;
 read(withdrawalId:string):Promise<SandboxExecution|null>;
 reserve(userId:string,requestId:string,context:ExecutionContext):Promise<SandboxExecution>;
 claim(row:SandboxExecution):Promise<boolean>;
 bind(row:SandboxExecution,id:string):Promise<void>;
 save(row:SandboxExecution,observation:WithdrawalObservation):Promise<SandboxExecution>;
}
export function validateWithdrawal(row:SandboxExecution,t:WithdrawalObservation){
 if((row.sendTransferId && row.sendTransferId!==t.id) || t.customerId!==row.providerCustomerId || t.sourceWalletId!==row.providerWalletId
  || t.destinationAddress!==row.walletAddress || t.network!=="solana" || t.sourceCurrency!=="USDT"
  || usdtUnits(t.sourceAmount)!==usdtUnits(row.amountUsdt) || (t.targetAmount!==null && (usdtUnits(t.targetAmount)<=0n || usdtUnits(t.targetAmount)>usdtUnits(row.amountUsdt))))throw new SandboxExecutionError("WITHDRAWAL_PROVIDER_CONTEXT_MISMATCH");
}
export function executionView(r:SandboxExecution){return{id:r.id,withdrawal_request_id:r.withdrawalId,request_id:r.requestId,
 state:r.observation?`provider_${r.observation.status}`:r.attempted?"uncertain":"reserved",environment:"test",real_money:false,
 source:{currency:"USDT",amount:r.amountUsdt},destination:{wallet_address:r.walletAddress,network:"solana",proof_network:"solana:devnet"},
 provider_target_amount:r.observation?.targetAmount??null,provider_transaction_reference:r.observation?.transactionReference??null,
 provider_completed:r.observation?.status==="completed" && r.observation.sourceLegStatus==="completed" && r.observation.destinationLegStatus==="completed",
 execution_requested:r.attempted,recovery_required:r.attempted && !r.observation,manual_review_required:r.observation!=null && ["needs_review","failed","cancelled","expired"].includes(r.observation.status),
 onchain_delivery_verified:false,mainnet_execution:false,delivery_costs_preflight_evaluated:false,pilot_slot_held:!r.closedAt,pilot_closed_at:r.closedAt??null,job_enqueued:false,automatic_retry:false};}
export class SandboxWithdrawalExecutionService {
 constructor(private readonly repository:SandboxExecutionRepository,private readonly provider:OzavSandboxWithdrawalProvider,private readonly guard:WithdrawalOperatorApprovalService){}
 authorize(user:AuthenticatedUser){this.guard.authorize(user);}
 async read(user:AuthenticatedUser,id:string){this.authorize(user);const row=await this.repository.read(id);if(!row)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_NOT_FOUND");return executionView(row);}
 async execute(user:AuthenticatedUser,withdrawalId:string,requestId:string){
  this.authorize(user);
  const prior=await this.repository.read(withdrawalId);
  if(prior && (prior.operatorId!==user.id || prior.requestId!==requestId))throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_ALREADY_REQUESTED");
  if(prior?.attempted)return{data:executionView(prior),replayed:true};
  const c=await this.repository.context(withdrawalId);if(!c)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED");
  if(!this.guard.isAllowed(c.approverId))throw new SandboxExecutionError("WITHDRAWAL_APPROVER_NO_LONGER_ALLOWED");
  if(!PublicKey.isOnCurve(new PublicKey(c.walletAddress).toBytes()) || !Number.isFinite(Date.parse(c.verifiedAt)) || Date.parse(c.verifiedAt)>Date.now())throw new SandboxExecutionError("WITHDRAWAL_DESTINATION_INVALID");
  await this.provider.capabilities();
  const funding=await this.provider.funding.getTransfer(c.transferId);validatePixTransfer(c,funding);
  if(funding.status!=="completed" || funding.sourceLegStatus!=="completed" || funding.destinationLegStatus!=="completed"
   || usdtUnits(funding.amounts.target.amount)!==usdtUnits(c.amountUsdt))throw new SandboxExecutionError("WITHDRAWAL_FUNDING_NOT_CONFIRMED");
  const identity=await this.provider.identity(c.providerCustomerId,onboardingExternalRef(c.customerId));
  const available=await this.provider.available(c.providerCustomerId,c.providerWalletId);
  if(usdtUnits(available)<usdtUnits(c.amountUsdt))throw new SandboxExecutionError("WITHDRAWAL_BALANCE_INSUFFICIENT");
  const row=await this.repository.reserve(user.id,requestId,c);
  if(!await this.repository.claim(row)){
   const latest=await this.repository.read(withdrawalId);if(!latest?.attempted)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED");return{data:executionView(latest),replayed:true};
  }
  row.attempted=true;
  const transferId=await this.provider.send({executionId:row.id,withdrawalId,customerId:row.providerCustomerId,walletId:row.providerWalletId,
   amount:row.amountUsdt,address:row.walletAddress,verifiedAt:row.verifiedAt,identity});
  await this.repository.bind(row,transferId);row.sendTransferId=transferId;
  const observed=await this.provider.transfer(transferId);validateWithdrawal(row,observed);
  return{data:executionView(await this.repository.save(row,observed)),replayed:false};
 }
 async reconcile(user:AuthenticatedUser,id:string){
  this.authorize(user);const row=await this.repository.read(id);if(!row)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_NOT_FOUND");
  if(!row.attempted || row.closedAt)return executionView(row);
  const found=row.sendTransferId??await this.provider.find(row.providerCustomerId,row.id);if(!found)return executionView(row);
  const observed=await this.provider.transfer(found);validateWithdrawal(row,observed);
  await this.repository.bind(row,found);row.sendTransferId=found;
  return executionView(await this.repository.save(row,observed));
 }
}
