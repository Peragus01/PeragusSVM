import {PublicKey} from "@solana/web3.js";
import {validatePixTransfer} from "../purchases/customer-sandbox-pix.js";
import {onboardingExternalRef} from "../onboarding/submission-types.js";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {moneyNetworkFor,type MoneyMode} from "../config/money-environment.js";
import type {OperationStatus} from "../purchases/operation-status.js";
import {requireFreshMfa,OPERATOR_MFA_MAX_AGE_SECONDS,type WithdrawalOperatorApprovalService} from "./operator-approvals.js";
import {SandboxWithdrawalProviderError,usdtUnits,type OzavSandboxWithdrawalProvider,type WithdrawalObservation} from "../providers/ozav-sandbox-withdrawal.js";
import type {DestinationTokenAccountReader} from "../providers/solana-token-accounts.js";
export class SandboxExecutionError extends Error {
 constructor(public readonly code:string,public readonly providerCode:string|null=null){super(code);}
}
export interface ExecutionContext {
 withdrawalId:string;customerId:string;approvalId:string;approverId:string;pixId:string;
 /** The purchase operation whose status moves approved -> sending -> sent. */
 purchaseId:string;
 providerCustomerId:string;providerWalletId:string;providerQuoteId:string;transferId:string;amountBrl:string;
 /** USDT converted into the managed wallet (the withdrawal request amount). */
 amountUsdt:string;
 /** USDT to send: the purchase's immutable locked_usdt_amount (null only on executions predating it). */
 sendAmountUsdt:string|null;
 walletAddress:string;
 /** The wallet proof timestamp (customer wallet verified_at), sent as wallet_attested_ownership_at. */
 verifiedAt:string;
 /** The approval's persisted created_at (database time). */
 approvedAt?:string;
 /** Seconds since the persisted approval, computed by the database (now() - created_at). */
 approvalAgeSeconds?:number;
 /** Current operation status, read with the context (the claim re-checks it under the row lock). */
 operationStatus?:OperationStatus;
}
/** Binding defaults: fresh TOTP <= 300 s, 900 s between approval and execution, four eyes off. */
export const OPERATOR_EXECUTION_MIN_DELAY_SECONDS=900;
export interface ExecutionPolicy {
 mfaMaxAgeSeconds:number;
 /** Minimum seconds between the persisted approval and an execution. */
 minDelaySeconds:number;
 /** When true the executor must be a different operator from the approver. */
 fourEyes:boolean;
 /** Epoch milliseconds; used for MFA freshness only (the delay uses the database clock). */
 now:()=>number;
}
export const defaultExecutionPolicy=(policy:Partial<ExecutionPolicy>={}):ExecutionPolicy=>({mfaMaxAgeSeconds:OPERATOR_MFA_MAX_AGE_SECONDS,
 minDelaySeconds:OPERATOR_EXECUTION_MIN_DELAY_SECONDS,fourEyes:false,now:()=>Date.now(),...policy});
/** The destination check before a send: the environment's USDT mint (MoneyEnvironment.usdtMint) and an RPC reader. */
export interface DestinationTokenAccountCheck {usdtMint:string;reader:DestinationTokenAccountReader;}
export const DESTINATION_TOKEN_ACCOUNT_MISSING="DESTINATION_TOKEN_ACCOUNT_MISSING";
export interface SandboxExecution extends ExecutionContext {
 id:string;operatorId:string;requestId:string;attempted:boolean;sendTransferId:string|null;observation:WithdrawalObservation|null;
 closedAt?:string|null;
 /** Money mode of the stored row (its environment column). */
 environment:MoneyMode;
 /** settlement_references.tx_hash as OZAV reported it. */
 txHash:string|null;
 /** OZAV definitively refused the send (e.g. TRAVEL_RULE_REQUIRED); never POSTed again. */
 refusalCode:string|null;
}
/** Outcome of the claim transaction. */
export type ExecutionClaim="claimed"|"taken"|"not_approved";
export interface SandboxExecutionRepository {
 context(withdrawalId:string):Promise<ExecutionContext|null>;
 read(withdrawalId:string):Promise<SandboxExecution|null>;
 reserve(userId:string,requestId:string,context:ExecutionContext):Promise<SandboxExecution>;
 /**
  * One transaction: locks the purchase row, requires status `approved`, marks the execution
  * attempted and moves the operation approved -> sending. Only "claimed" may POST.
  */
 claim(row:SandboxExecution):Promise<ExecutionClaim>;
 /** Binds the OZAV transfer (and tx hash when known) and moves a `sending` operation to `sent`. */
 bind(row:SandboxExecution,id:string,txHash?:string|null,actor?:string):Promise<void>;
 save(row:SandboxExecution,observation:WithdrawalObservation):Promise<SandboxExecution>;
 /** Records a definitive OZAV refusal and moves the operation sending -> needs_review. */
 refuse(row:SandboxExecution,code:string,actor:string):Promise<SandboxExecution>;
 /** Stores the latest destination check (null clears a previous blocker). */
 recordDestinationCheck(withdrawalId:string,customerId:string,blocker:string|null):Promise<void>;
}
/** The amount that was (or will be) POSTed: the locked amount, or amount_usdt for pre-Task-10 rows. */
export const sendAmount=(row:Pick<ExecutionContext,"sendAmountUsdt"|"amountUsdt">)=>row.sendAmountUsdt??row.amountUsdt;
export function validateWithdrawal(row:SandboxExecution,t:WithdrawalObservation){
 const sent=usdtUnits(sendAmount(row));
 if((row.sendTransferId && row.sendTransferId!==t.id) || t.customerId!==row.providerCustomerId || t.sourceWalletId!==row.providerWalletId
  || t.destinationAddress!==row.walletAddress || t.network!=="solana" || t.sourceCurrency!=="USDT"
  || usdtUnits(t.sourceAmount)!==sent || (t.targetAmount!==null && (usdtUnits(t.targetAmount)<=0n || usdtUnits(t.targetAmount)>sent)))throw new SandboxExecutionError("WITHDRAWAL_PROVIDER_CONTEXT_MISMATCH");
}
export function executionView(r:SandboxExecution){
 const live=r.environment==="live";
 return{id:r.id,withdrawal_request_id:r.withdrawalId,request_id:r.requestId,
 state:r.observation?`provider_${r.observation.status}`:r.refusalCode?"provider_refused":r.attempted?"uncertain":"reserved",environment:r.environment,real_money:live,
 source:{currency:"USDT",amount:sendAmount(r)},destination:{wallet_address:r.walletAddress,network:"solana",proof_network:moneyNetworkFor(r.environment)},
 provider_target_amount:r.observation?.targetAmount??null,provider_transaction_reference:r.observation?.transactionReference??r.txHash??null,
 provider_refusal_code:r.refusalCode,
 provider_completed:r.observation?.status==="completed" && r.observation.sourceLegStatus==="completed" && r.observation.destinationLegStatus==="completed",
 execution_requested:r.attempted,recovery_required:r.attempted && !r.observation && !r.refusalCode,
 manual_review_required:r.refusalCode!==null || (r.observation!=null && ["needs_review","failed","cancelled","expired"].includes(r.observation.status)),
 onchain_delivery_verified:false,mainnet_execution:live && r.attempted,delivery_costs_preflight_evaluated:false,pilot_slot_held:!r.closedAt,pilot_closed_at:r.closedAt??null,job_enqueued:false,automatic_retry:false};}
export class SandboxWithdrawalExecutionService {
 private readonly policy:ExecutionPolicy;
 constructor(private readonly repository:SandboxExecutionRepository,private readonly provider:OzavSandboxWithdrawalProvider,private readonly guard:WithdrawalOperatorApprovalService,
  private readonly destination:DestinationTokenAccountCheck,policy:Partial<ExecutionPolicy>={}){
  if(!destination?.reader || typeof destination.usdtMint!=="string")throw new Error("DESTINATION_TOKEN_ACCOUNT_CHECK_REQUIRED");
  this.policy=defaultExecutionPolicy(policy);
 }
 /** The provider's money mode (the route asks for a mode-specific confirmation). */
 get mode():MoneyMode{return this.provider.mode==="live"?"live":"test";}
 authorize(user:AuthenticatedUser){this.guard.authorize(user);}
 async read(user:AuthenticatedUser,id:string){this.authorize(user);const row=await this.repository.read(id);if(!row)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_NOT_FOUND");return executionView(row);}
 async execute(user:AuthenticatedUser,withdrawalId:string,requestId:string){
  this.authorize(user);
  const now=this.policy.now();
  requireFreshMfa(user,this.policy.mfaMaxAgeSeconds,now/1000);
  const prior=await this.repository.read(withdrawalId);
  if(prior && (prior.operatorId!==user.id || prior.requestId!==requestId))throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_ALREADY_REQUESTED");
  if(prior?.attempted)return{data:executionView(prior),replayed:true};
  const c=await this.repository.context(withdrawalId);if(!c)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED");
  if(!this.guard.isAllowed(c.approverId))throw new SandboxExecutionError("WITHDRAWAL_APPROVER_NO_LONGER_ALLOWED");
  if(this.policy.fourEyes && c.approverId.toLowerCase()===user.id.toLowerCase())throw new SandboxExecutionError("EXECUTION_REQUIRES_SECOND_OPERATOR");
  // Elapsed time since the persisted approval, measured by the database clock; never client input.
  const age=c.approvalAgeSeconds;
  if(typeof age!=="number" || !Number.isFinite(age))throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED");
  if(age<this.policy.minDelaySeconds)throw new SandboxExecutionError("EXECUTION_TOO_EARLY");
  // Fail fast; the claim re-checks the status under the purchase row lock.
  if(c.operationStatus!=="approved")throw new SandboxExecutionError("WITHDRAWAL_OPERATION_NOT_APPROVED");
  // OZAV deducts the network fee from the sent amount; the send is the immutable locked amount.
  if(c.sendAmountUsdt===null)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED");
  const amount=usdtUnits(c.sendAmountUsdt);
  if(amount<=0n || amount>usdtUnits(c.amountUsdt))throw new SandboxExecutionError("WITHDRAWAL_SEND_AMOUNT_INVALID");
  if(!PublicKey.isOnCurve(new PublicKey(c.walletAddress).toBytes()) || !Number.isFinite(Date.parse(c.verifiedAt)) || Date.parse(c.verifiedAt)>Date.now())throw new SandboxExecutionError("WITHDRAWAL_DESTINATION_INVALID");
  await this.provider.capabilities();
  const funding=await this.provider.funding.getTransfer(c.transferId);validatePixTransfer(c,funding);
  if(funding.status!=="completed" || funding.sourceLegStatus!=="completed" || funding.destinationLegStatus!=="completed"
   || usdtUnits(funding.amounts.target.amount)!==usdtUnits(c.amountUsdt))throw new SandboxExecutionError("WITHDRAWAL_FUNDING_NOT_CONFIRMED");
  const identity=await this.provider.identity(c.providerCustomerId,onboardingExternalRef(c.customerId));
  const available=await this.provider.available(c.providerCustomerId,c.providerWalletId);
  if(usdtUnits(available)<amount)throw new SandboxExecutionError("WITHDRAWAL_BALANCE_INSUFFICIENT");
  // The destination must already hold a token account for this environment's USDT mint.
  let hasAccount:boolean;
  try{hasAccount=await this.destination.reader.hasTokenAccount(c.walletAddress,this.destination.usdtMint)===true;}
  catch{throw new SandboxExecutionError("DESTINATION_TOKEN_ACCOUNT_UNVERIFIED");}
  await this.repository.recordDestinationCheck(c.withdrawalId,c.customerId,hasAccount?null:DESTINATION_TOKEN_ACCOUNT_MISSING);
  if(!hasAccount)throw new SandboxExecutionError(DESTINATION_TOKEN_ACCOUNT_MISSING);
  // Travel Rule: identify the self-custodied destination (attested by the wallet proof) before the send.
  // It moves no money and a repeat only records the latest identification, so a failure here leaves
  // the operation approved with nothing claimed.
  try{await this.provider.identifyDestination(c.providerCustomerId,c.walletAddress,c.verifiedAt);}
  catch{throw new SandboxExecutionError("DESTINATION_IDENTIFICATION_FAILED");}
  const row=await this.repository.reserve(user.id,requestId,c);
  const claim=await this.repository.claim(row);
  if(claim!=="claimed"){
   const latest=await this.repository.read(withdrawalId);
   if(latest?.attempted)return{data:executionView(latest),replayed:true};
   throw new SandboxExecutionError(claim==="not_approved"?"WITHDRAWAL_OPERATION_NOT_APPROVED":"WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED");
  }
  row.attempted=true;
  const actor=`operator:${user.id}`;
  let accepted:Awaited<ReturnType<OzavSandboxWithdrawalProvider["send"]>>;
  try{
   accepted=await this.provider.send({executionId:row.id,withdrawalId,customerId:row.providerCustomerId,walletId:row.providerWalletId,
    amount:sendAmount(row),address:row.walletAddress,verifiedAt:row.verifiedAt,identity});
  }catch(error){
   // A definitive refusal created no transfer: review, never re-POST. Anything else stays
   // `sending` and is recovered by metadata/GET only.
   if(error instanceof SandboxWithdrawalProviderError && error.definitive){
    const code=error.providerCode??`HTTP_${error.statusCode}`;
    await this.repository.refuse(row,code,actor);
    throw new SandboxExecutionError("WITHDRAWAL_SEND_REFUSED",code);
   }
   throw error;
  }
  await this.repository.bind(row,accepted.id,accepted.txHash,actor);row.sendTransferId=accepted.id;row.txHash=accepted.txHash??row.txHash;
  const observed=await this.provider.transfer(accepted.id);validateWithdrawal(row,observed);
  return{data:executionView(await this.repository.save(row,observed)),replayed:false};
 }
 async reconcile(user:AuthenticatedUser,id:string){
  this.authorize(user);const row=await this.repository.read(id);if(!row)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_NOT_FOUND");
  if(!row.attempted || row.closedAt || row.refusalCode)return executionView(row);
  const found=row.sendTransferId??await this.provider.find(row.providerCustomerId,row.id);if(!found)return executionView(row);
  const observed=await this.provider.transfer(found);validateWithdrawal(row,observed);
  await this.repository.bind(row,found,null,`operator:${user.id}`);row.sendTransferId=found;
  return executionView(await this.repository.save(row,observed));
 }
}
