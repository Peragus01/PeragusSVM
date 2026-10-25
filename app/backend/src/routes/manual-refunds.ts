import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {ManualRefundError,refundReason,decisionReason,refundReference,refundAmount,type ManualRefundService} from "../refunds/manual-refunds.js";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";
import {OperationHistoryInputError} from "../purchases/customer-operation-history.js";

export async function registerManualRefundRoutes(app:FastifyInstance,service?:ManualRefundService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser("application/json");
  scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_request,body,done)=>done(null,body));
  const customerPath="/v1/me/operations/:id/refund-request",adminPath="/v1/admin/refund-requests";
  for(const [action,method,url] of [
   ["customer_read","GET",customerPath],["request","POST",customerPath],
   ["list","GET",adminPath],["operator_read","GET",adminPath+"/:id"],
   ["decision","POST",adminPath+"/:id/decision"],["completion","POST",adminPath+"/:id/completion"]
  ] as const)scoped.route({method,url,bodyLimit:4096,handler:async(request,reply)=>{
   reply.header("Cache-Control","no-store");const user=request.authenticatedUser;
   if(!user)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
   if(!service)return reply.code(503).send({error:{code:"MANUAL_REFUNDS_UNAVAILABLE"}});
   const customerAction=action==="request" || action==="customer_read";
   try{
    const customer=request.authenticatedCustomer;
    if(customerAction){if(!customer || customer.type!=="pf" || customer.suspended)return reply.code(403).send({error:{code:"INDIVIDUAL_PROFILE_REQUIRED"}});}
    else service.authorize(user);
    if(action==="list"){
     if(request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     return await service.list(user,request.query);
    }
    const params=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!params.success || Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    if(method==="GET"){
     if(request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     return {data:customerAction?await service.customerRead(customer!.id,params.data.id):await service.operatorRead(user,params.data.id)};
    }
    let body:unknown;try{body=JSON.parse((request.body as Buffer).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
    let result;
    if(action==="request"){
     const parsed=z.object({request_id:z.string().uuid(),reason:refundReason}).strict().safeParse(body);
     if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     result=await service.request(customer!.id,params.data.id,parsed.data.request_id,parsed.data.reason);
    }else if(action==="decision"){
     const parsed=z.object({request_id:z.string().uuid(),decision:z.enum(["approved","rejected"]),reason:decisionReason,
      confirmation:z.literal("MANUAL_REVIEW_COMPLETED")}).strict().safeParse(body);
     if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     result=await service.decide(user,params.data.id,parsed.data.request_id,parsed.data.decision,parsed.data.reason);
    }else{
     const parsed=z.object({request_id:z.string().uuid(),amount_brl:refundAmount,reference:refundReference,
      confirmation:z.literal("MANUAL_REFUND_EXECUTED_EXTERNALLY")}).strict().safeParse(body);
     if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     result=await service.complete(user,params.data.id,parsed.data.request_id,parsed.data.amount_brl,parsed.data.reference);
    }
    return reply.code(result.replayed?200:201).send({data:result.data,meta:{idempotent_replay:result.replayed,record_only:true,refund_execution_automated:false}});
   }catch(error){
    if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
    if(error instanceof OperationHistoryInputError)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    if(error instanceof ManualRefundError)return reply.code(error.code.endsWith("NOT_FOUND")?404:error.code.endsWith("DISABLED")?503:409).send({error:{code:error.code}});
    request.log.warn({event:"manual_refund_unavailable"});return reply.code(503).send({error:{code:"MANUAL_REFUNDS_UNAVAILABLE"}});
   }
  }});
 });
}
