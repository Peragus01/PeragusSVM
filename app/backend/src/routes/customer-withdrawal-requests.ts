import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {WithdrawalRequestError, type CustomerWithdrawalRequestService} from "../withdrawals/customer-withdrawal-requests.js";
export async function registerCustomerWithdrawalRequestRoutes(app:FastifyInstance,service?:CustomerWithdrawalRequestService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser("application/json");
  scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_req,body,done)=>done(null,body));
  for(const method of ["GET","POST"] as const)scoped.route({method,url:method==="GET"?"/v1/me/withdrawal-requests/:id":"/v1/me/withdrawal-requests",bodyLimit:4096,
   handler:async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
    if(!service)return reply.code(503).send({error:{code:"CUSTOMER_WITHDRAWAL_REQUESTS_DISABLED"}});
    const customer=request.authenticatedCustomer;
    if(!customer || customer.type!=="pf" || customer.suspended)return reply.code(403).send({error:{code:"INDIVIDUAL_PROFILE_REQUIRED"}});
    if(Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    try{
     if(method==="GET"){
      const parsed=z.object({id:z.string().uuid()}).safeParse(request.params);
      if(!parsed.success || request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
      return{data:await service.read(customer.id,parsed.data.id)};
     }
     let body:unknown;try{body=JSON.parse((request.body as Buffer).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
     const parsed=z.object({request_id:z.string().uuid(),pix_id:z.string().uuid()}).strict().safeParse(body);
     if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     const result=await service.record(customer.id,parsed.data.request_id,parsed.data.pix_id);
     reply.header("Location",`/v1/me/withdrawal-requests/${result.data.id}`);
     return reply.code(result.replayed?200:201).send({data:result.data,meta:{idempotent_replay:result.replayed,record_only:true,withdrawal_started:result.data.withdrawal_started,job_enqueued:false}});
    }catch(error){
     if(error instanceof WithdrawalRequestError)return reply.code(["WITHDRAWAL_REQUEST_NOT_FOUND","WITHDRAWAL_PIX_NOT_FOUND"].includes(error.code)?404:409).send({error:{code:error.code}});
     request.log.warn({event:"customer_withdrawal_request_unavailable"});return reply.code(503).send({error:{code:"WITHDRAWAL_REQUEST_UNAVAILABLE"}});
    }
   }
  });
 });
}
