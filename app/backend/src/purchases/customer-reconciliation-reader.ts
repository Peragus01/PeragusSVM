import type {Pool} from "pg";
import {providerKeyMatchesMode,type MoneyMode} from "../config/money-environment.js";
import {OzavClient,type OzavTransport} from "../providers/ozav-client.js";
import {OzavSandboxWithdrawalProvider} from "../providers/ozav-sandbox-withdrawal.js";
import {PostgresCustomerPixRepository} from "../repositories/postgres-customer-sandbox-pix.js";
import {PostgresSandboxExecutionRepository} from "../repositories/postgres-sandbox-withdrawal-execution.js";
import {recoverSandboxWithdrawal} from "../withdrawals/sandbox-recovery.js";
import type {DeliveryCheck} from "../withdrawals/sandbox-execution.js";
import {reconcileCustomerPix} from "./customer-sandbox-pix.js";
import type {CustomerReconciliationReader} from "../jobs/customer-reconciliation.js";
import {refreshPixAndProgress,type PurchaseProgression} from "./purchase-progression.js";

/** Returns two GET-only functions. There is no send, reserve, claim or simulation capability. */
export function createCustomerReconciliationReader(pool:Pool,key:string,mode:MoneyMode,read?:OzavTransport,
 progression?:Pick<PurchaseProgression,"applyTransferObservation">,delivery?:DeliveryCheck):CustomerReconciliationReader{
 // The key, provider clients and repositories all belong to the configured money mode.
 if(!providerKeyMatchesMode(key,mode))throw Error("Provider key for the money mode required");
 const client=new OzavClient({apiKey:key,mode,attempts:1,timeoutMs:10000,...(read?{transport:read}:{})});
 const withdrawal=new OzavSandboxWithdrawalProvider(key,{mode,...(read?{read}:{})});
 const pixRepository=new PostgresCustomerPixRepository(pool,mode),withdrawalRepository=new PostgresSandboxExecutionRepository(pool,mode);
 const pixProvider=Object.freeze({findCustomerPixTransfer:client.findCustomerPixTransfer.bind(client),getTransfer:client.getTransfer.bind(client)});
 const withdrawalProvider=Object.freeze({find:withdrawal.find.bind(withdrawal),transfer:withdrawal.transfer.bind(withdrawal)});
 return Object.freeze({
  pix:async(customerId:string,id:string)=>{
   // The GET observation (never a webhook body) drives the purchase operation forward.
   const view=progression?await refreshPixAndProgress(pixRepository,pixProvider,progression,customerId,id,mode,"system:reconciliation")
    :await reconcileCustomerPix(pixRepository,pixProvider,customerId,id,mode);
   const failed=["failed","cancelled","expired"].includes(view.state);
   return {status:view.state,complete:view.custody_conversion_completed || failed,
    review:view.state==="needs_review" || (view.state==="completed" && !view.custody_conversion_completed) || (failed && view.source_leg_status==="completed")};
  },
  withdrawal:async(customerId:string,id:string)=>{
   // With a delivery check the same GET-only pass verifies the delivery on chain
   // (sent -> delivered_verified | needs_review), acting as system:reconciliation.
   const view=await recoverSandboxWithdrawal(withdrawalRepository,withdrawalProvider,id,customerId,delivery,"system:reconciliation");
   const status=view.state.startsWith("provider_")?view.state.slice(9):view.state;
   // A completed send keeps being checked until its delivery is settled (verified, or simulated in test).
   const settled=!delivery || view.onchain_delivery_verified || view.delivery_simulated;
   return {status,complete:view.provider_completed && settled,review:view.manual_review_required || (status==="completed" && !view.provider_completed)};
  }
 });
}
