import type {FastifyInstance} from "fastify";
import {OperatorNotificationListInputError,type OperatorNotificationListService} from "../operations/operator-notification-list.js";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";

/** GET /v1/admin/operator-notifications?status=uncertain|failed: allowlist + AAL2, read-only, no PII. */
export async function registerOperatorNotificationRoutes(app:FastifyInstance,service?:OperatorNotificationListService){
 app.get("/v1/admin/operator-notifications",async(request,reply)=>{
  reply.header("Cache-Control","no-store");
  if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
  if(!service)return reply.code(503).send({error:{code:"OPERATOR_NOTIFICATIONS_UNAVAILABLE"}});
  try{
   if(request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
   return await service.list(request.authenticatedUser,request.query);
  }catch(error){
   if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
   if(error instanceof OperatorNotificationListInputError)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
   request.log.warn({event:"operator_notifications_unavailable"});
   return reply.code(503).send({error:{code:"OPERATOR_NOTIFICATIONS_UNAVAILABLE"}});
  }
 });
}
