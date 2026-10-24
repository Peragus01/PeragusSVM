import type {AuthenticatedUser} from "../auth/customer-access.js";
import {OzavSandboxWithdrawalProvider} from "../providers/ozav-sandbox-withdrawal.js";
import {authorizeWithdrawalOperator} from "./operator-approvals.js";
import {SandboxExecutionError,executionView,validateWithdrawal,type SandboxExecutionRepository} from "./sandbox-execution.js";

type RecoveryRepository=Pick<SandboxExecutionRepository,"read"|"bind"|"save">;
type RecoveryReader=Pick<OzavSandboxWithdrawalProvider,"find"|"transfer">;

/** Exposes GET operations only; no send operation reaches the recovery service. */
export function createSandboxRecoveryReader(key:string):RecoveryReader {
 const provider=new OzavSandboxWithdrawalProvider(key);
 return Object.freeze({find:provider.find.bind(provider),transfer:provider.transfer.bind(provider)});
}

/** May persist validated observations, but cannot reserve/claim or initiate a transfer. */
export class SandboxWithdrawalRecoveryService {
 constructor(private readonly repository:RecoveryRepository,private readonly provider:RecoveryReader,
  private readonly operators:ReadonlySet<string>){}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.operators);}
 async read(user:AuthenticatedUser,id:string){
  this.authorize(user);const row=await this.repository.read(id);
  if(!row)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_NOT_FOUND");
  return executionView(row);
 }
 async reconcile(user:AuthenticatedUser,id:string){
  this.authorize(user);const row=await this.repository.read(id);
  if(!row)throw new SandboxExecutionError("WITHDRAWAL_EXECUTION_NOT_FOUND");
  if(!row.attempted)return executionView(row);
  const found=row.sendTransferId??await this.provider.find(row.providerCustomerId,row.id);
  if(!found)return executionView(row);
  const observation=await this.provider.transfer(found);
  validateWithdrawal(row,observation);
  await this.repository.bind(row,found);row.sendTransferId=found;
  return executionView(await this.repository.save(row,observation));
 }
}
