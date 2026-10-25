import type {Pool} from "pg";
import {OzavClient,type OzavTransport} from "../providers/ozav-client.js";
import {OzavSandboxWithdrawalProvider} from "../providers/ozav-sandbox-withdrawal.js";
import {PostgresCustomerPixRepository} from "../repositories/postgres-customer-sandbox-pix.js";
import {PostgresSandboxExecutionRepository} from "../repositories/postgres-sandbox-withdrawal-execution.js";
import {recoverSandboxWithdrawal} from "../withdrawals/sandbox-recovery.js";
import {reconcileCustomerPix} from "./customer-sandbox-pix.js";
import type {CustomerReconciliationReader} from "../jobs/customer-reconciliation.js";

/** Returns two GET-only functions. There is no send, reserve, claim or simulation capability. */
export function createCustomerReconciliationReader(pool:Pool,key:string,read?:OzavTransport):CustomerReconciliationReader{
 if(!/^ozav_sk_test_[A-Za-z0-9_-]+$/.test(key))throw Error("Sandbox key required");
 const client=new OzavClient({apiKey:key,attempts:1,timeoutMs:10000,...(read?{transport:read}:{})});
 const withdrawal=new OzavSandboxWithdrawalProvider(key,read?{read}:{});
 const pixRepository=new PostgresCustomerPixRepository(pool),withdrawalRepository=new PostgresSandboxExecutionRepository(pool);
 const pixProvider=Object.freeze({findCustomerPixTransfer:client.findCustomerPixTransfer.bind(client),getTransfer:client.getTransfer.bind(client)});
 const withdrawalProvider=Object.freeze({find:withdrawal.find.bind(withdrawal),transfer:withdrawal.transfer.bind(withdrawal)});
 return Object.freeze({
  pix:async(customerId:string,id:string)=>{
   const view=await reconcileCustomerPix(pixRepository,pixProvider,customerId,id);
   const failed=["failed","cancelled","expired"].includes(view.state);
   return {status:view.state,complete:view.custody_conversion_completed || failed,
    review:view.state==="needs_review" || (view.state==="completed" && !view.custody_conversion_completed) || (failed && view.source_leg_status==="completed")};
  },
  withdrawal:async(customerId:string,id:string)=>{
   const view=await recoverSandboxWithdrawal(withdrawalRepository,withdrawalProvider,id,customerId);
   const status=view.state.startsWith("provider_")?view.state.slice(9):view.state;
   return {status,complete:view.provider_completed,review:view.manual_review_required || (status==="completed" && !view.provider_completed)};
  }
 });
}
