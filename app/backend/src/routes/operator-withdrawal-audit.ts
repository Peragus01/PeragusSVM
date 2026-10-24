import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {OperatorAuditNotFound,type OperatorWithdrawalAuditService} from "../withdrawals/operator-withdrawal-audit.js";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";
export async function registerOperatorWithdrawalAuditRoutes(app:FastifyInstance,service?:OperatorWithdrawalAuditService){
 app.get("/v1/admin/withdrawal-requests/:id/audit",async(request,reply)=>{
  reply.header("Cache-Control","no-store");
  if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
  if(!service)return reply.code(503).send({error:{code:"WITHDRAWAL_AUDIT_UNAVAILABLE"}});
  try{
   service.authorize(request.authenticatedUser);
   const params=z.object({id:z.string().uuid()}).safeParse(request.params);
   if(!params.success || request.body!==undefined || Object.keys(request.query as object).length)
    return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
   return {data:await service.read(request.authenticatedUser,params.data.id)};
  }catch(error){
   if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
   if(error instanceof OperatorAuditNotFound)return reply.code(404).send({error:{code:"WITHDRAWAL_REQUEST_NOT_FOUND"}});
   request.log.warn({event:"operator_withdrawal_audit_unavailable"});
   return reply.code(503).send({error:{code:"WITHDRAWAL_AUDIT_UNAVAILABLE"}});
  }
 });
}
