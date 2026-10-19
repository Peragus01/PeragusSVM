import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {CustomerPixError, type CustomerSandboxPixService} from "../purchases/customer-sandbox-pix.js";
export async function registerCustomerSandboxPixRoutes(app:FastifyInstance,service?:CustomerSandboxPixService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser("application/json");
  scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_req,body,done)=>done(null,body));
  for(const action of ["create","read","reconcile"] as const)scoped.route({
   method:action==="read"?"GET":"POST",url:action==="create"?"/v1/me/sandbox-pix":`/v1/me/sandbox-pix/:id${action==="reconcile"?"/reconcile":""}`,bodyLimit:4096,
   handler:async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
    if(!service)return reply.code(503).send({error:{code:"CUSTOMER_SANDBOX_PIX_DISABLED"}});
    const customer=request.authenticatedCustomer;
    if(!customer || customer.type!=="pf" || customer.suspended)return reply.code(403).send({error:{code:"INDIVIDUAL_PROFILE_REQUIRED"}});
    if(Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    try{
     if(action==="create"){
      let body:unknown;try{body=JSON.parse((request.body as Buffer).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
      const parsed=z.object({request_id:z.string().uuid(),purchase_intent_id:z.string().uuid()}).strict().safeParse(body);
      if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
      const result=await service.create(customer.id,parsed.data.request_id,parsed.data.purchase_intent_id);
      reply.header("Location",`/v1/me/sandbox-pix/${result.data.id}`);
      return reply.code(result.replayed?200:result.data.recovery_required?202:201).send({data:result.data,meta:{idempotent_replay:result.replayed}});
     }
     const params=z.object({id:z.string().uuid()}).safeParse(request.params);
     if(!params.success || request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     return{data:action==="read"?await service.read(customer.id,params.data.id):await service.reconcile(customer.id,params.data.id)};
    }catch(error){
     if(error instanceof CustomerPixError)return reply.code(error.code==="PIX_NOT_FOUND"?404:409).send({error:{code:error.code,automatic_retry:false}});
     request.log.warn({event:"customer_sandbox_pix_recovery_required"});
     return reply.code(503).send({error:{code:"PIX_OUTCOME_REQUIRES_RECOVERY",automatic_retry:false}});
    }
   }
  });
 });
}
