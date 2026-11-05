import type {SandboxWithdrawalRecoveryService} from "../withdrawals/sandbox-recovery.js";
import {SandboxWithdrawalProviderError} from "../providers/ozav-sandbox-withdrawal.js";
import {OzavClientError} from "../providers/ozav-client.js";
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";
import {SandboxExecutionError,type SandboxWithdrawalExecutionService} from "../withdrawals/sandbox-execution.js";
export async function registerSandboxWithdrawalExecutionRoutes(app:FastifyInstance,service?:SandboxWithdrawalExecutionService,recovery?:SandboxWithdrawalRecoveryService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser("application/json");scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_req,body,done)=>done(null,body));
  for(const action of ["read","execute","reconcile"] as const)scoped.route({method:action==="read"?"GET":"POST",url:`/v1/admin/withdrawal-requests/:id/execution${action==="reconcile"?"/reconcile":""}`,bodyLimit:4096,
   handler:async(request,reply)=>{
    reply.header("Cache-Control","no-store");const user=request.authenticatedUser;if(!user)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
    const reader=recovery??service;
    if(action==="execute"?!service:!reader)return reply.code(503).send({error:{code:"SANDBOX_WITHDRAWAL_EXECUTION_DISABLED"}});
    try{
     (action==="execute"?service!:reader!).authorize(user);const params=z.object({id:z.string().uuid()}).safeParse(request.params);
     if(!params.success || Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     if(action!=="execute"){
      if(request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
      return{data:action==="read"?await reader!.read(user,params.data.id):await reader!.reconcile(user,params.data.id)};
     }
     let body:unknown;try{body=JSON.parse((request.body as Buffer).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
     const parsed=z.object({request_id:z.string().uuid(),confirmation:z.literal("SANDBOX_ONLY")}).strict().safeParse(body);
     if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     const result=await service!.execute(user,params.data.id,parsed.data.request_id);
     return reply.code(result.replayed?200:result.data.recovery_required?202:201).send({data:result.data,meta:{idempotent_replay:result.replayed}});
    }catch(error){
     if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
     if(error instanceof SandboxExecutionError)return reply.code(error.code.endsWith("NOT_FOUND")?404:409).send({error:{code:error.code,automatic_retry:false}});
     request.log.warn({event:"sandbox_withdrawal_execution_recovery_required"});return reply.code(503).send({error:{code:"WITHDRAWAL_EXECUTION_REQUIRES_RECOVERY",provider_http_status:error instanceof OzavClientError?error.statusCode??null:null,provider_code:error instanceof SandboxWithdrawalProviderError?error.providerCode:null,automatic_retry:false}});
    }
   }
  });
 });
}
