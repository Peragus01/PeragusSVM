import {PublicKey} from "@solana/web3.js";
import {validatePixTransfer} from "../purchases/customer-sandbox-pix.js";
import {onboardingExternalRef} from "../onboarding/submission-types.js";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {moneyNetworkFor,type MoneyMode} from "../config/money-environment.js";
import type {OperationStatus} from "../purchases/operation-status.js";
import {requireFreshMfa,OPERATOR_MFA_MAX_AGE_SECONDS,type WithdrawalOperatorApprovalService} from "./operator-approvals.js";
import {SandboxWithdrawalProviderError,usdtUnits,type OzavSandboxWithdrawalProvider,type WithdrawalObservation} from "../providers/ozav-sandbox-withdrawal.js";
import {OzavClientError} from "../providers/ozav-client.js";
import type {DestinationTokenAccountReader,TokenAccountState} from "../providers/solana-token-accounts.js";
import {isSolanaSignature,verifyUsdtDelivery,type DeliveryVerification,type DeliveryVerificationInput} from "../solana/usdt-delivery-verifier.js";
export class SandboxExecutionError extends Error {
 /** providerStatus: the provider's HTTP status, when the refusal came from a provider answer. */
 constructor(public readonly code:string,public readonly providerCode:string|null=null,public readonly providerStatus:number|null=null){super(code);}
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
export const DESTINATION_TOKEN_ACCOUNT_FROZEN="DESTINATION_TOKEN_ACCOUNT_FROZEN";
/** Default shortfall accepted between the locked amount and the delivered amount: 0.10 USDT (network fee). */
export const DEFAULT_USDT_DELIVERY_TOLERANCE_UNITS=100000n;
/**
 * The independent on-chain check that completes an operation: the environment's USDT mint, how far
 * the net delivery may fall below the locked amount, and a read-only RPC (getParsedTransaction).
 */
export interface DeliveryCheck {usdtMint:string;toleranceUnits:bigint;connection:DeliveryVerificationInput["connection"];}
export type DeliveryStatus="verified"|"simulated"|"review";
/** What the delivery check concluded; `reason` is stored and, for review, becomes the status event reason. */
/** pending: nothing decided yet (stays `sent`); its reason is stored as delivery_pending_reason. */
export type DeliveryOutcome={status:"verified";deliveredUnits:bigint;reason:string}|{status:"review"|"simulated"|"pending";reason:string};
export interface SandboxExecution extends ExecutionContext {
 id:string;operatorId:string;requestId:string;attempted:boolean;sendTransferId:string|null;observation:WithdrawalObservation|null;
 closedAt?:string|null;
 /** Money mode of the stored row (its environment column). */
 environment:MoneyMode;
 /** settlement_references.tx_hash as OZAV reported it. */
 txHash:string|null;
 /** OZAV definitively refused the send (e.g. TRAVEL_RULE_REQUIRED); never POSTed again. */
 refusalCode:string|null;
 /** verified: finalized on chain as expected; simulated: test send absent from devnet; review: the chain disagrees. */
 deliveryStatus?:DeliveryStatus|null;
 deliveryReason?:string|null;
 /** USDT credited to the wallet on chain (set only when verified). */
 deliveredAmountUsdt?:string|null;
 /** A transfer found by metadata for a send OZAV answered as refused (must not exist). */
 refusedTransferId?:string|null;
 /** Live: when the pilot slot was released by the operation reaching a final status. */
 slotReleasedAt?:string|null;
 /** Why a completed send is still undecided (NOT_FINALIZED, RPC_UNAVAILABLE, NO_TX_HASH). */
 deliveryPendingReason?:string|null;
 /** When the send was claimed; the verified transaction must not predate it. */
 sendAttemptedAt?:string|null;
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
 /**
  * One transaction under the purchase row lock, only while the operation is `sent`: stores the
  * delivery outcome and moves sent -> delivered_verified (verified) or sent -> needs_review
  * (review); simulated only labels the execution. Returns the row unchanged when nothing applied.
  */
 recordDelivery(row:SandboxExecution,outcome:DeliveryOutcome,actor:string):Promise<SandboxExecution>;
 /** Records that a transfer exists for a refused send (raises the high-severity operator alert). */
 flagRefusedTransfer(row:SandboxExecution,transferId:string):Promise<void>;
 /** Stores why an undecided completed send is still pending (no status change). */
 recordDeliveryPending(row:SandboxExecution,reason:string):Promise<SandboxExecution>;
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
 manual_review_required:r.refusalCode!==null || r.deliveryStatus==="review" || (r.observation!=null && ["needs_review","failed","cancelled","expired"].includes(r.observation.status)),
 // True only when the finalized transaction credited this wallet with the expected mint and amount.
 onchain_delivery_verified:r.deliveryStatus==="verified",delivery_status:r.deliveryStatus??null,delivery_reason:r.deliveryReason??null,
 delivered_amount:r.deliveredAmountUsdt??null,delivery_simulated:r.deliveryStatus==="simulated",
 refused_transfer_found:r.refusedTransferId!=null,
 mainnet_execution:live && r.attempted,delivery_costs_preflight_evaluated:false,pilot_slot_held:!r.closedAt && !r.slotReleasedAt,pilot_closed_at:r.closedAt??null,
 pilot_slot_released_at:r.slotReleasedAt??null,delivery_pending_reason:r.deliveryPendingReason??null,job_enqueued:false,automatic_retry:false};}
const completedSend=(o:WithdrawalObservation|null):o is WithdrawalObservation=>o?.status==="completed" && o.sourceLegStatus==="completed" && o.destinationLegStatus==="completed";
/** Clock allowance between the send claim (database time) and the transaction's block time. */
export const DELIVERY_BLOCK_TIME_ALLOWANCE_SECONDS=120;
const formatUsdt=(units:bigint)=>`${units/1000000n}.${String(units%1000000n).padStart(6,"0")}`;
/** Error code safe to log: an upper-case code from our own code, never a provider/RPC message. */
const errorCode=(error:unknown)=>error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)?error.message:"RPC_UNAVAILABLE";
/**
 * Decides the delivery of a completed send (never moves money, reads one transaction).
 * Ruling 30: verified iff the finalized transaction credited the customer's wallet with the
 * environment's USDT mint, in a block not older than the send claim (minus a 120 s clock
 * allowance), and
 *   (a) locked_usdt_amount - USDT_DELIVERY_TOLERANCE_UNITS <= credit <= locked_usdt_amount, and
 *   (b) credit == OZAV's settled amounts.target.amount (OZAV updates it on wallet -> crypto_address
 *       sends); a difference is review ONCHAIN_CREDIT_DIFFERS_FROM_SETTLED. Without a settled
 *       target the operation stays `sent` (pending SETTLED_TARGET_NOT_REPORTED).
 *  - The chain contradicts (failed tx, older tx, other mint, other recipient, amount out of range): review.
 *  - Live: no hash yet, not finalized or RPC unavailable -> pending (stays `sent`, retried);
 *    a hash that is not a Solana signature -> review TX_HASH_INVALID.
 *  - Test: no hash, not a signature or not on devnet -> simulated (stays `sent`).
 * Returns null when the send is not completed yet.
 */
export async function decideDelivery(row:SandboxExecution,delivery:DeliveryCheck):Promise<DeliveryOutcome|null>{
 const o=row.observation;
 if(!completedSend(o))return null;
 const live=row.environment==="live",sent=sendAmount(row),locked=usdtUnits(sent);
 const tolerance=delivery.toleranceUnits<locked?delivery.toleranceUnits:0n;
 if(row.txHash && o.transactionReference && row.txHash!==o.transactionReference)return{status:"review",reason:"TX_HASH_CHANGED: provider reported a different transaction"};
 const txHash=row.txHash??o.transactionReference;
 if(!txHash)return live?{status:"pending",reason:"NO_TX_HASH"}:{status:"simulated",reason:"SIMULATED: test send without a transaction hash"};
 if(!isSolanaSignature(txHash))return live?{status:"review",reason:"TX_HASH_INVALID"}:{status:"simulated",reason:"SIMULATED: test send reference is not a Solana signature"};
 // Ruling 30: OZAV updates target.amount to the settled amount; until it reports one, wait.
 if(o.targetAmount===null)return{status:"pending",reason:"SETTLED_TARGET_NOT_REPORTED"};
 const settled=usdtUnits(o.targetAmount);
 const attempted=row.sendAttemptedAt?Date.parse(row.sendAttemptedAt):NaN;
 let result:DeliveryVerification;
 try{
  result=await verifyUsdtDelivery({connection:delivery.connection,txHash,mint:delivery.usdtMint,ownerWallet:row.walletAddress,
   expectedUnits:locked,toleranceUnits:tolerance,
   ...(Number.isFinite(attempted)?{notBeforeUnix:Math.floor(attempted/1000)-DELIVERY_BLOCK_TIME_ALLOWANCE_SECONDS}:{})});
 }catch(error){
  // RPC unavailable or unreadable: stays `sent`, the next reconciliation tries again.
  const code=errorCode(error);
  console.warn(JSON.stringify({event:"usdt_delivery_check_failed",execution_id:row.id,environment:row.environment,code}));
  return{status:"pending",reason:code};
 }
 if(result.verified){
  if(result.deliveredUnits!==settled)return{status:"review",reason:"ONCHAIN_CREDIT_DIFFERS_FROM_SETTLED"};
  return{status:"verified",deliveredUnits:result.deliveredUnits,
   reason:`VERIFIED_ONCHAIN: credit ${formatUsdt(result.deliveredUnits)} equals settled target ${o.targetAmount}, within locked ${sent} minus tolerance`};
 }
 if(result.reason==="NOT_FINALIZED")return live?{status:"pending",reason:"NOT_FINALIZED"}:{status:"simulated",reason:"SIMULATED: test transaction not found on devnet"};
 return{status:"review",reason:result.reason};
}
type ReconcileRepository=Pick<SandboxExecutionRepository,"bind"|"save"|"recordDelivery"|"recordDeliveryPending"|"flagRefusedTransfer">;
type ReconcileReader=Pick<OzavSandboxWithdrawalProvider,"find"|"transfer">;
/**
 * GET-only reconciliation of one attempted execution (operator route and background job):
 * finds/refreshes the OZAV transfer (sending -> sent) and, with a delivery check, verifies the
 * delivery on chain (sent -> delivered_verified | needs_review). Never reserves, claims or sends.
 */
export async function reconcileExecution(repository:ReconcileRepository,provider:ReconcileReader,row:SandboxExecution,actor:string,delivery?:DeliveryCheck){
 if(!row.attempted || row.closedAt)return executionView(row);
 if(row.refusalCode){
  // A refused send must have left no transfer. Look for one by metadata; if it exists the
  // operator is alerted (it is never bound, re-sent or verified automatically).
  if(!row.refusedTransferId){
   const stray=await provider.find(row.providerCustomerId,row.id);
   if(stray){await repository.flagRefusedTransfer(row,stray);row.refusedTransferId=stray;}
  }
  return executionView(row);
 }
 const found=row.sendTransferId??await provider.find(row.providerCustomerId,row.id);if(!found)return executionView(row);
 const observed=await provider.transfer(found);validateWithdrawal(row,observed);
 await repository.bind(row,found,null,actor);row.sendTransferId=found;
 let saved=await repository.save(row,observed);
 if(delivery && saved.deliveryStatus!=="verified" && saved.deliveryStatus!=="review"){
  const outcome=await decideDelivery(saved,delivery);
  if(outcome?.status==="pending"){
   if(!saved.deliveryStatus && saved.deliveryPendingReason!==outcome.reason)saved=await repository.recordDeliveryPending(saved,outcome.reason);
  }else if(outcome && !(outcome.status==="simulated" && saved.deliveryStatus==="simulated"))saved=await repository.recordDelivery(saved,outcome,actor);
 }
 return executionView(saved);
}
export class SandboxWithdrawalExecutionService {
 private readonly policy:ExecutionPolicy;
 constructor(private readonly repository:SandboxExecutionRepository,private readonly provider:OzavSandboxWithdrawalProvider,private readonly guard:WithdrawalOperatorApprovalService,
  private readonly destination:DestinationTokenAccountCheck,policy:Partial<ExecutionPolicy>={},private readonly delivery?:DeliveryCheck){
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
  let state:TokenAccountState;
  try{state=await this.destination.reader.tokenAccountState(c.walletAddress,this.destination.usdtMint);}
  catch{throw new SandboxExecutionError("DESTINATION_TOKEN_ACCOUNT_UNVERIFIED");}
  if(state!=="ready" && state!=="missing" && state!=="frozen")throw new SandboxExecutionError("DESTINATION_TOKEN_ACCOUNT_UNVERIFIED");
  // A frozen account exists but cannot receive: reported apart from a missing one.
  const blocker=state==="ready"?null:state==="frozen"?DESTINATION_TOKEN_ACCOUNT_FROZEN:DESTINATION_TOKEN_ACCOUNT_MISSING;
  await this.repository.recordDestinationCheck(c.withdrawalId,c.customerId,blocker);
  if(blocker)throw new SandboxExecutionError(blocker);
  // Travel Rule: identify the self-custodied destination (attested by the wallet proof) before the send.
  // It moves no money and a repeat only records the latest identification, so a failure here leaves
  // the operation approved with nothing claimed.
  try{await this.provider.identifyDestination(c.providerCustomerId,c.walletAddress,c.verifiedAt);}
  catch(error){throw new SandboxExecutionError("DESTINATION_IDENTIFICATION_FAILED",null,error instanceof OzavClientError?error.statusCode??null:null);}
  const row=await this.repository.reserve(user.id,requestId,c);
  // The stored row is what gets sent: it must carry exactly the amount and destination validated above.
  if(row.sendAmountUsdt===null || usdtUnits(row.sendAmountUsdt)!==amount || row.walletAddress!==c.walletAddress)
   throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_CONTEXT_MISMATCH");
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
  return reconcileExecution(this.repository,this.provider,row,`operator:${user.id}`,this.delivery);
 }
}
