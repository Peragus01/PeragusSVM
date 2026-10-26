import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {SandboxClosureError,type SandboxClosureService} from '../withdrawals/sandbox-closure.js';
import {OperatorApprovalError} from '../withdrawals/operator-approvals.js';
import {SandboxExecutionError} from '../withdrawals/sandbox-execution.js';
export async function registerSandboxClosureRoutes(app:FastifyInstance,service?:SandboxClosureService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser('application/json');
  scoped.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:4096},(_r,b,d)=>d(null,b));
  for(const method of ['GET','POST'] as const)scoped.route({method,url:'/v1/admin/withdrawal-requests/:id/execution/closure',bodyLimit:4096,handler:async(request,reply)=>{
   reply.header('Cache-Control','no-store');
   if(!request.authenticatedUser)return reply.code(401).send({error:{code:'AUTH_REQUIRED'}});
   if(!service)return reply.code(503).send({error:{code:'SANDBOX_WITHDRAWAL_CLOSURE_DISABLED'}});
   try {
    service.authorize(request.authenticatedUser);
    const params=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!params.success || Object.keys(request.query as object).length)return reply.code(400).send({error:{code:'VALIDATION_ERROR'}});
    if(method==='GET'){
     if(request.body!==undefined)return reply.code(400).send({error:{code:'VALIDATION_ERROR'}});
     return {data:await service.read(request.authenticatedUser,params.data.id)};
    }
    let body:unknown;try{body=JSON.parse((request.body as Buffer).toString('utf8'));}catch{return reply.code(400).send({error:{code:'VALIDATION_ERROR'}});}
    const parsed=z.object({request_id:z.string().uuid(),reason:z.string().trim().min(10).max(300).refine(s=>!/[\x00-\x1f\x7f]/.test(s)),confirmation:z.literal('CLOSE_COMPLETED_SANDBOX_PILOT')}).strict().safeParse(body);
    if(!parsed.success)return reply.code(400).send({error:{code:'VALIDATION_ERROR'}});
    const result=await service.close(request.authenticatedUser,params.data.id,parsed.data.request_id,parsed.data.reason);
    return reply.code(result.replayed?200:201).send({data:result.data,meta:{idempotent_replay:result.replayed}});
   }catch(error){
    if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
    if(error instanceof SandboxClosureError || error instanceof SandboxExecutionError){
     const status=error.code.endsWith('DISABLED') || error.code.endsWith('UNAVAILABLE')?503:error.code.endsWith('NOT_FOUND')?404:409;
     return reply.code(status).send({error:{code:error.code}});
    }
    request.log.warn({event:'sandbox_closure_unavailable'});
    return reply.code(503).send({error:{code:'WITHDRAWAL_CLOSURE_UNAVAILABLE'}});
   }
  }});
 });
}
