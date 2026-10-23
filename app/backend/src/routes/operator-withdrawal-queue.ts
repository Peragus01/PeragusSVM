import type {FastifyInstance} from "fastify";
import type {OperatorWithdrawalQueueService} from "../withdrawals/operator-withdrawal-queue.js";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";
import {OperationHistoryInputError} from "../purchases/customer-operation-history.js";

export async function registerOperatorWithdrawalQueueRoutes(app:FastifyInstance,service?:OperatorWithdrawalQueueService){
 app.get("/v1/admin/withdrawal-requests",async(request,reply)=>{
  reply.header("Cache-Control","no-store");
  if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
  if(!service)return reply.code(503).send({error:{code:"WITHDRAWAL_QUEUE_UNAVAILABLE"}});
  try{
   if(request.body!==undefined)throw new OperationHistoryInputError();
   return await service.list(request.authenticatedUser,request.query);
  }catch(error){
   if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
   if(error instanceof OperationHistoryInputError)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
   request.log.warn({event:"operator_withdrawal_queue_unavailable"});
   return reply.code(503).send({error:{code:"WITHDRAWAL_QUEUE_UNAVAILABLE"}});
  }
 });
}
