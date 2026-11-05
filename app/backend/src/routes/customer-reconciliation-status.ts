import type {FastifyInstance} from "fastify";
import {CustomerReconciliationInputError,type CustomerReconciliationStatusService} from "../jobs/customer-reconciliation.js";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";
export async function registerCustomerReconciliationStatusRoutes(app:FastifyInstance,service?:CustomerReconciliationStatusService){
 app.get("/v1/admin/customer-reconciliation",async(request,reply)=>{
  reply.header("Cache-Control","no-store");
  if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
  if(!service)return reply.code(503).send({error:{code:"CUSTOMER_RECONCILIATION_UNAVAILABLE"}});
  try{
   if(request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
   return await service.list(request.authenticatedUser,request.query);
  }catch(error){
   if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
   if(error instanceof CustomerReconciliationInputError)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
   request.log.warn({event:"customer_reconciliation_status_unavailable"});
   return reply.code(503).send({error:{code:"CUSTOMER_RECONCILIATION_UNAVAILABLE"}});
  }
 });
}
