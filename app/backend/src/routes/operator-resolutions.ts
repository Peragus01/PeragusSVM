import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {OperatorResolutionError,type OperatorResolutionService} from "../operations/operator-resolutions.js";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";
import {refundReason} from "../refunds/manual-refunds.js";
import {PurchaseIntentError} from "../purchases/customer-purchase-intents.js";

/**
 * Operator resolutions (Ruling 39), :id is the purchase id:
 *  POST /v1/admin/operations/:id/resolutions/close-unpaid-review   {request_id, reason}
 *  POST /v1/admin/operations/:id/resolutions/reverify-delivery     {request_id, reason}
 *  POST /v1/admin/operations/:id/resolutions/return-approved-to-review {request_id, reason}
 *  POST /v1/admin/operations/:id/reconcile-pix (no body; GET-only + progression)
 *  GET  /v1/admin/operations/:id/resolutions
 * Allowlist + AAL2; the three resolutions also need a fresh TOTP and a reason (audited).
 */
export async function registerOperatorResolutionRoutes(app:FastifyInstance,service?:OperatorResolutionService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser("application/json");
  scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_request,body,done)=>done(null,body));
  const base="/v1/admin/operations/:id";
  const actions={"close-unpaid-review":"closeUnpaidReview","reverify-delivery":"reverifyDelivery","return-approved-to-review":"returnApprovedToReview"} as const;
  const routes:[string,"GET"|"POST",string][]=[["list","GET",`${base}/resolutions`],["reconcile","POST",`${base}/reconcile-pix`],
   ...Object.keys(actions).map(a=>[a,"POST",`${base}/resolutions/${a}`] as [string,"POST",string])];
  for(const [action,method,url] of routes)scoped.route({method,url,bodyLimit:4096,handler:async(request,reply)=>{
   reply.header("Cache-Control","no-store");const user=request.authenticatedUser;
   if(!user)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
   if(!service)return reply.code(503).send({error:{code:"OPERATOR_RESOLUTIONS_UNAVAILABLE"}});
   const params=z.object({id:z.string().uuid()}).safeParse(request.params);
   if(!params.success || Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
   try{
    service.authorize(user);
    if(action==="list"){if(request.body!==undefined)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});return await service.list(user,params.data.id);}
    if(action==="reconcile"){
     if(request.body!==undefined && (request.body as Buffer).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
     return await service.reconcilePix(user,params.data.id);
    }
    let body:unknown;try{body=JSON.parse(((request.body as Buffer|undefined)??Buffer.from("")).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
    const parsed=z.object({request_id:z.string().uuid(),reason:refundReason}).strict().safeParse(body);
    if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    const method=actions[action as keyof typeof actions];
    const result=await service[method](user,params.data.id,parsed.data.request_id,parsed.data.reason);
    return reply.code(result.replayed?200:201).send({data:result.data,meta:{idempotent_replay:result.replayed}});
   }catch(error){
    if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
    if(error instanceof OperatorResolutionError)return reply.code(error.code.endsWith("NOT_FOUND")?404:error.code.endsWith("UNAVAILABLE")?503
     :error.code==="OPERATOR_ACCOUNT_SEPARATION_REQUIRED"?403:error.code==="RESOLUTION_REASON_INVALID"?400:409).send({error:{code:error.code}});
    if(error instanceof PurchaseIntentError)return reply.code(409).send({error:{code:error.code}});
    const code=error && typeof error==="object" && "code" in error && typeof (error as {code:unknown}).code==="string"
     && /^[A-Z][A-Z0-9_]{2,63}$/.test((error as {code:string}).code)?(error as {code:string}).code:null;
    if(code && (code.startsWith("WITHDRAWAL_") || code.startsWith("PIX_") || code==="REFUND_WITHDRAWAL_IN_PROGRESS"))return reply.code(409).send({error:{code}});
    request.log.warn({event:"operator_resolution_unavailable"});return reply.code(503).send({error:{code:"OPERATOR_RESOLUTIONS_UNAVAILABLE"}});
   }
  }});
 });
}
