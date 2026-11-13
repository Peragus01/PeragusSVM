import {randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresCustomerPurchaseIntentRepository} from "../src/repositories/postgres-customer-purchase-intents.js";
import {CustomerPurchaseIntentService} from "../src/purchases/customer-purchase-intents.js";
import {assertPreviousDayReviewed,DailyReviewRequiredError,DailyReviewService} from "../src/operations/daily-review.js";
import {allAcceptedLegal} from "./helpers/legal-double.js";
import {setRuntimeControls} from "./helpers/runtime-controls.js";
import {migrateAll,pglitePool,purchaseReadyCustomer} from "./helpers/operation-fixture.js";

vi.setConfig({testTimeout:60000});
const db=new PGlite(),pool=pglitePool(db);
const wide={maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}};
const repository=new PostgresCustomerPurchaseIntentRepository(pool,"test",wide);
const purchases=new CustomerPurchaseIntentService(repository);
const customers=new PostgresCustomerRepository(pool);
const operatorId=randomUUID();
const fresh=(at=Math.floor(Date.now()/1000))=>({id:operatorId,email:"operator@example.test",assuranceLevel:"aal2" as const,mfaVerifiedAt:at});
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
async function appFor(identity:object){
 const app=await buildApp({operatorUserIds:new Set([operatorId]),dailyReviewService:new DailyReviewService(pool,new Set([operatorId]),"test"),
  customerPurchaseIntentService:purchases,
  customerAccess:{legal:allAcceptedLegal,customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return identity as any;}}});
 apps.push(app);return app;
}
const headers={authorization:"Bearer valid"};
const spDay=async(offset:number)=>(await db.query<{d:string}>("select ((now() at time zone 'America/Sao_Paulo')::date+$1::int)::text d",[offset])).rows[0]!.d;
/** One status event at noon (São Paulo) of `day`, on an existing operation. */
async function activityOn(day:string){
 const s=await purchaseReadyCustomer(db,pool);
 const accepted=await purchases.record(s.customer.id,s.requestId,s.quoteId);
 await db.query(`insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment,created_at)
  values($1,$2,'accepted','accepted','system:test','synthetic note','test',($3::date+time '12:00') at time zone 'America/Sao_Paulo')`,[accepted.data.id,s.customer.id,day]);
 return accepted.data.id;
}

beforeAll(async()=>{await migrateAll(db);await db.exec("insert into peragus_database_environment(environment) values('test')");},60000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
beforeEach(async()=>{await setRuntimeControls(db,true);});

describe("daily review",()=>{
 it("no block when yesterday had no operations",async()=>{
  const client={query:(sql:string,params?:unknown[])=>db.query(sql,params)} as any;
  await expect(assertPreviousDayReviewed(client)).resolves.toBeUndefined();
  // Today's activity never blocks today.
  const s=await purchaseReadyCustomer(db,pool);
  await expect(purchases.record(s.customer.id,s.requestId,s.quoteId)).resolves.toMatchObject({replayed:false});
  const t=await purchaseReadyCustomer(db,pool);
  await expect(purchases.record(t.customer.id,t.requestId,t.quoteId)).resolves.toMatchObject({replayed:false});
 });

 it("new operation blocked when yesterday had operations and no review",async()=>{
  const yesterday=await spDay(-1);
  const old=await activityOn(yesterday);
  const s=await purchaseReadyCustomer(db,pool);
  await expect(purchases.record(s.customer.id,s.requestId,s.quoteId)).rejects.toMatchObject({code:"DAILY_REVIEW_REQUIRED",day:yesterday});
  expect((await db.query("select count(*)::int n from peragus_customer_purchase_intents where customer_id=$1",[s.customer.id])).rows[0]).toEqual({n:0});
  // HTTP: 503 DAILY_REVIEW_REQUIRED naming the day.
  const customerApp=await appFor({id:s.owner,email:"customer@example.test"});
  const blocked=await customerApp.inject({method:"POST",url:"/v1/me/purchase-intents",headers,payload:{request_id:randomUUID(),quote_id:s.quoteId}});
  expect(blocked.statusCode).toBe(503);
  expect(blocked.json()).toEqual({error:{code:"DAILY_REVIEW_REQUIRED",day:yesterday,automatic_retry:false}});
  // Never blocks reconciliation/progression, refunds or sends of existing operations: transitions proceed.
  await expect(repository.transitionOperation(old,"awaiting_pix","system:reconciliation","synthetic")).resolves.toMatchObject({changed:true});
  // The scanner's view and an explicit clock agree: a review of another day does not count.
  const client={query:(sql:string,params?:unknown[])=>db.query(sql,params)} as any;
  await expect(assertPreviousDayReviewed(client)).rejects.toBeInstanceOf(DailyReviewRequiredError);
  await expect(assertPreviousDayReviewed(client,new Date(Date.now()+86_400_000*3))).resolves.toBeUndefined();
  // The operator reviews yesterday (allowlist + fresh MFA); new operations resume.
  const app=await appFor(fresh());
  const review=await app.inject({method:"POST",url:"/v1/admin/daily-reviews",headers,payload:{day:yesterday,note:"Revisado: 1 operação, sem divergências."}});
  expect(review.statusCode).toBe(200);expect(review.headers["cache-control"]).toBe("no-store");
  expect(review.json().data).toMatchObject({day:yesterday,reviewed_by:operatorId,changed:true,environment:"test"});
  await expect(purchases.record(s.customer.id,s.requestId,s.quoteId)).resolves.toMatchObject({replayed:false});
 });

 it("review route needs the operator allowlist and fresh MFA, validates the day and is idempotent and append-only",async()=>{
  const url="/v1/admin/daily-reviews",today=await spDay(0),tomorrow=await spDay(1),day=await spDay(-2);
  const outsider=await appFor({id:randomUUID(),email:"x@example.test",assuranceLevel:"aal2",mfaVerifiedAt:Math.floor(Date.now()/1000)});
  expect((await outsider.inject({method:"POST",url,headers,payload:{day}})).json().error.code).toBe("WITHDRAWAL_OPERATOR_REQUIRED");
  const stale=await appFor(fresh(Math.floor(Date.now()/1000)-301));
  const r=await stale.inject({method:"POST",url,headers,payload:{day}});
  expect(r.statusCode).toBe(403);expect(r.json().error.code).toBe("OPERATOR_MFA_STALE");
  const app=await appFor(fresh());
  for(const bad of [{day:tomorrow},{day:"2026-02-30"},{day:"yesterday"},{day,note:"a\nb"},{day,note:"x".repeat(501)},{day,extra:1},{}]){
   const res=await app.inject({method:"POST",url,headers,payload:bad});
   expect(res.statusCode,JSON.stringify(bad)).toBe(400);
  }
  // A day can only be reviewed after it ends (São Paulo): today is refused, nothing recorded.
  const early=await app.inject({method:"POST",url,headers,payload:{day:today}});
  expect(early.statusCode).toBe(409);expect(early.json()).toEqual({error:{code:"DAILY_REVIEW_DAY_NOT_ENDED"}});
  expect((await db.query("select count(*)::int n from peragus_daily_reviews where day=$1::date and reviewed_by=$2",[today,operatorId])).rows[0]).toEqual({n:0});
  const first=await app.inject({method:"POST",url,headers,payload:{day}});
  expect(first.json().data).toMatchObject({day,changed:true,note:null});
  const again=await app.inject({method:"POST",url,headers,payload:{day,note:"outra nota"}});
  expect(again.json().data).toMatchObject({day,changed:false,note:null});
  await expect(db.query("update peragus_daily_reviews set note='x'")).rejects.toThrow("DAILY_REVIEWS_APPEND_ONLY");
  await expect(db.query("delete from peragus_daily_reviews")).rejects.toThrow("DAILY_REVIEWS_APPEND_ONLY");
  await expect(db.query("insert into peragus_daily_reviews(day,environment,reviewed_by) values('2026-01-02','live',$1)",[operatorId])).rejects.toThrow("ENVIRONMENT_MISMATCH");
  const grants=await db.query("select grantee from information_schema.role_table_grants where table_name='peragus_daily_reviews' and grantee in ('anon','authenticated','PUBLIC')");
  expect(grants.rows).toEqual([]);
  // A customer account is never an operator.
  const s=await purchaseReadyCustomer(db,pool);
  const service=new DailyReviewService(pool,new Set([s.owner]),"test");
  await expect(service.review({id:s.owner,email:"c@example.test",assuranceLevel:"aal2",mfaVerifiedAt:Math.floor(Date.now()/1000)},day)).rejects.toMatchObject({code:"OPERATOR_ACCOUNT_SEPARATION_REQUIRED"});
 });
});
