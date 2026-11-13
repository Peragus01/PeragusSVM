import type {FastifyInstance} from "fastify";
import {OperatorApprovalError} from "../withdrawals/operator-approvals.js";
import {DailyReviewError,dailyReviewInput,type DailyReviewService} from "../operations/daily-review.js";

/** POST /v1/admin/daily-reviews: operator allowlist + fresh MFA; the review row is the audit. */
export async function registerDailyReviewRoutes(app:FastifyInstance,service?:DailyReviewService){
 await app.register(async scoped=>{
  scoped.removeContentTypeParser("application/json");
  scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_request,body,done)=>done(null,body));
  scoped.post("/v1/admin/daily-reviews",{bodyLimit:4096},async(request,reply)=>{
   reply.header("Cache-Control","no-store");const user=request.authenticatedUser;
   if(!user)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
   if(!service)return reply.code(503).send({error:{code:"DAILY_REVIEWS_UNAVAILABLE"}});
   try{
    service.authorize(user);
    if(Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    let body:unknown;try{body=JSON.parse((request.body as Buffer).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
    const parsed=dailyReviewInput.safeParse(body);
    if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    const result=await service.review(user,parsed.data.day,parsed.data.note);
    request.log.info({event:"daily_review_recorded",day:result.day,changed:result.changed});
    return{data:result};
   }catch(error){
    if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
    if(error instanceof DailyReviewError)return reply.code(error.code==="OPERATOR_ACCOUNT_SEPARATION_REQUIRED"?403:error.code==="DAILY_REVIEW_DAY_NOT_ENDED"?409:400).send({error:{code:error.code}});
    request.log.warn({event:"daily_reviews_unavailable"});return reply.code(503).send({error:{code:"DAILY_REVIEWS_UNAVAILABLE"}});
   }
  });
 });
}
