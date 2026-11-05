import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {OperatorApprovalError,type WithdrawalOperatorApprovalService} from "../withdrawals/operator-approvals.js";
export async function registerWithdrawalOperatorApprovalRoutes(app:FastifyInstance,service?:WithdrawalOperatorApprovalService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser("application/json");scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_req,body,done)=>done(null,body));
  for(const method of ["GET","POST"] as const)scoped.route({method,url:"/v1/admin/withdrawal-requests/:id/approval",bodyLimit:4096,
   handler:async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    const user=request.authenticatedUser;if(!user)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
    if(!service)return reply.code(503).send({error:{code:"WITHDRAWAL_OPERATOR_APPROVALS_DISABLED"}});
    try{
     service.authorize(user);
     const params=z.object({id:z.string().uuid()}).safeParse(request.params);
     if(!params.success || Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     if(method==="GET"){
      if(request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
      return{data:await service.read(user,params.data.id)};
     }
     let body:unknown;try{body=JSON.parse((request.body as Buffer).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
     const parsed=z.object({request_id:z.string().uuid(),reason:z.string().trim().min(10).max(300).regex(/^[^\x00-\x1f\x7f]+$/)}).strict().safeParse(body);
     if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     const result=await service.approve(user,params.data.id,parsed.data.request_id,parsed.data.reason);
     return reply.code(result.replayed?200:201).send({data:result.data,meta:{idempotent_replay:result.replayed}});
    }catch(error){
     if(error instanceof OperatorApprovalError){const status=error.code.endsWith("NOT_FOUND")?404:["WITHDRAWAL_OPERATOR_REQUIRED","WITHDRAWAL_OPERATOR_MFA_REQUIRED"].includes(error.code)?403:409;return reply.code(status).send({error:{code:error.code}});}
     request.log.warn({event:"withdrawal_operator_approval_unavailable"});return reply.code(503).send({error:{code:"WITHDRAWAL_APPROVAL_UNAVAILABLE"}});
    }
   }
  });
 });
}
