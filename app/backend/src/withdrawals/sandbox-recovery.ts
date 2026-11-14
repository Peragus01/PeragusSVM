import type {AuthenticatedUser} from "../auth/customer-access.js";
import type {MoneyMode} from "../config/money-environment.js";
import {OzavSandboxWithdrawalProvider} from "../providers/ozav-sandbox-withdrawal.js";
import {authorizeWithdrawalOperator} from "./operator-approvals.js";
import {SandboxExecutionError,executionView,reconcileExecution,type DeliveryCheck,type SandboxExecutionRepository} from "./sandbox-execution.js";

type RecoveryRepository=Pick<SandboxExecutionRepository,"read"|"bind"|"save"|"recordDelivery"|"recordDeliveryPending"|"flagRefusedTransfer"|"markRefusedFindClear"|"recordSendEnded">;
type RecoveryReader=Pick<OzavSandboxWithdrawalProvider,"find"|"transfer">;

/** Exposes GET operations only; no send operation reaches the recovery service. */
export function createSandboxRecoveryReader(key:string,mode:MoneyMode):RecoveryReader {
 const provider=new OzavSandboxWithdrawalProvider(key,{mode});
 return Object.freeze({find:provider.find.bind(provider),transfer:provider.transfer.bind(provider)});
}

/**
 * May persist validated observations and the on-chain delivery outcome, but cannot
 * reserve/claim or initiate a transfer.
 */
export class SandboxWithdrawalRecoveryService {
 constructor(private readonly repository:RecoveryRepository,private readonly provider:RecoveryReader,
  private readonly operators:ReadonlySet<string>,private readonly delivery?:DeliveryCheck){}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.operators);}
 async read(user:AuthenticatedUser,id:string){
  this.authorize(user);const row=await this.repository.read(id);
  if(!row)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_NOT_FOUND");
  return executionView(row);
 }
 async reconcile(user:AuthenticatedUser,id:string){
  this.authorize(user);return recoverSandboxWithdrawal(this.repository,this.provider,id,undefined,this.delivery,`operator:${user.id}`);
 }
}

/** Background callers must pass the checkpoint customer; HTTP callers authorize above. */
export async function recoverSandboxWithdrawal(repository:RecoveryRepository,provider:RecoveryReader,id:string,customerId?:string,
 delivery?:DeliveryCheck,actor="system:withdrawal_recovery"){
 const row=await repository.read(id);
 if(!row || (customerId!==undefined && row.customerId!==customerId))throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_NOT_FOUND");
 return reconcileExecution(repository,provider,row,actor,delivery);
}
