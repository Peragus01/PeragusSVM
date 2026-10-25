import {z} from "zod";
import type {FastifyInstance} from "fastify";
import {CustomerOperationHistoryService,OperationHistoryInputError,parseHistoryQuery} from "../purchases/customer-operation-history.js";

export async function registerCustomerOperationHistoryRoutes(app:FastifyInstance,service?:CustomerOperationHistoryService){
  app.get("/v1/me/operations",async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
    const customer=request.authenticatedCustomer;
    if(!customer || customer.type!=="pf" || customer.suspended)return reply.code(403).send({error:{code:"INDIVIDUAL_PROFILE_REQUIRED"}});
    if(!service)return reply.code(503).send({error:{code:"OPERATION_HISTORY_UNAVAILABLE"}});
    try{
      if(request.body!==undefined)throw new OperationHistoryInputError();
      return await service.list(customer.id,parseHistoryQuery(request.query));
    }catch(error){
      if(error instanceof OperationHistoryInputError)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
      request.log.warn({event:"customer_operation_history_unavailable"});
      return reply.code(503).send({error:{code:"OPERATION_HISTORY_UNAVAILABLE"}});
    }
  });
  app.get("/v1/me/operations/:id",async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
    const customer=request.authenticatedCustomer;
    if(!customer || customer.type!=="pf" || customer.suspended)return reply.code(403).send({error:{code:"INDIVIDUAL_PROFILE_REQUIRED"}});
    const parsed=z.object({id:z.string().uuid()}).strict().safeParse(request.params);
    if(!parsed.success || Object.keys(request.query as object).length || request.body!==undefined)
      return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    if(!service)return reply.code(503).send({error:{code:"OPERATION_HISTORY_UNAVAILABLE"}});
    try{
      const data=await service.get(customer.id,parsed.data.id);
      if(!data)return reply.code(404).send({error:{code:"OPERATION_NOT_FOUND"}});
      return {data};
    }catch{
      request.log.warn({event:"customer_operation_detail_unavailable"});
      return reply.code(503).send({error:{code:"OPERATION_HISTORY_UNAVAILABLE"}});
    }
  });
}
