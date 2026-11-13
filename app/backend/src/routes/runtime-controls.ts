import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";
import {RuntimeControlError,runtimeControlKey,runtimeControlReason,type RuntimeControlService} from "../operations/runtime-controls.js";

/** GET/PUT /v1/admin/runtime-controls: operator allowlist + fresh MFA; every change is audited. */
export async function registerRuntimeControlRoutes(app:FastifyInstance,service?:RuntimeControlService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser("application/json");
  scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_request,body,done)=>done(null,body));
  for(const method of ["GET","PUT"] as const)scoped.route({method,url:"/v1/admin/runtime-controls",bodyLimit:4096,handler:async(request,reply)=>{
   reply.header("Cache-Control","no-store");const user=request.authenticatedUser;
   if(!user)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
   if(!service)return reply.code(503).send({error:{code:"RUNTIME_CONTROLS_UNAVAILABLE"}});
   try{
    service.authorize(user);
    if(Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    if(method==="GET"){
     if(request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     return{data:await service.list(user)};
    }
    let body:unknown;try{body=JSON.parse((request.body as Buffer).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
    const parsed=z.object({key:runtimeControlKey,enabled:z.boolean(),reason:runtimeControlReason}).strict().safeParse(body);
    if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    const result=await service.set(user,parsed.data.key,parsed.data.enabled,parsed.data.reason);
    request.log.info({event:"runtime_control_changed",key:result.key,enabled:result.enabled,changed:result.changed});
    return{data:result};
   }catch(error){
    if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
    if(error instanceof RuntimeControlError)return reply.code(error.code==="OPERATOR_ACCOUNT_SEPARATION_REQUIRED"?403:error.code==="RUNTIME_CONTROL_NOT_FOUND"?404:400).send({error:{code:error.code}});
    request.log.warn({event:"runtime_controls_unavailable"});return reply.code(503).send({error:{code:"RUNTIME_CONTROLS_UNAVAILABLE"}});
   }
  }});
 });
}
