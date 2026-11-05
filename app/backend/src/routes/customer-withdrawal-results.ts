import type {FastifyInstance} from "fastify";
import {z} from "zod";
import type {CustomerWithdrawalResultService} from "../withdrawals/customer-withdrawal-results.js";
import {WithdrawalRequestError} from "../withdrawals/customer-withdrawal-requests.js";

export async function registerCustomerWithdrawalResultRoutes(app:FastifyInstance,service?:CustomerWithdrawalResultService){
  app.get("/v1/me/withdrawal-requests/:id/result",async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
    if(!service)return reply.code(503).send({error:{code:"WITHDRAWAL_RESULT_UNAVAILABLE"}});
    const customer=request.authenticatedCustomer;
    if(!customer || customer.type!=="pf" || customer.suspended)return reply.code(403).send({error:{code:"INDIVIDUAL_PROFILE_REQUIRED"}});
    const params=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!params.success || Object.keys(request.query as object).length || request.body!==undefined)
      return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    try{return {data:await service.read(customer.id,params.data.id)};}
    catch(error){
      if(error instanceof WithdrawalRequestError)return reply.code(404).send({error:{code:error.code}});
      request.log.warn({event:"customer_withdrawal_result_unavailable"});
      return reply.code(503).send({error:{code:"WITHDRAWAL_RESULT_UNAVAILABLE"}});
    }
  });
}
