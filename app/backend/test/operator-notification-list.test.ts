import {randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {OperatorNotificationListService} from "../src/operations/operator-notification-list.js";
import {allAcceptedLegal} from "./helpers/legal-double.js";
import {migrateAll,pglitePool} from "./helpers/operation-fixture.js";

vi.setConfig({testTimeout:60000});
const db=new PGlite(),pool=pglitePool(db);
const customers=new PostgresCustomerRepository(pool);
const operatorId=randomUUID();
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
const url="/v1/admin/operator-notifications";
const headers={authorization:"Bearer valid"};
async function appFor(identity:object){
 const app=await buildApp({operatorUserIds:new Set([operatorId]),
  operatorNotificationListService:new OperatorNotificationListService(pool,new Set([operatorId]),"test"),
  customerAccess:{legal:allAcceptedLegal,customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return identity as any;}}});
 apps.push(app);return app;
}
const operator={id:operatorId,email:"operator@example.test",assuranceLevel:"aal2" as const,mfaVerifiedAt:Math.floor(Date.now()/1000)-3600};
/** One enqueued notification pair moved to `status` (pending -> sending -> uncertain, or pending -> failed). */
async function notification(kind:string,status:"pending"|"failed"|"uncertain"|"accepted",payload:object={}){
 const key=`synthetic:${randomUUID()}`;
 await db.query("select peragus_enqueue_operator_notification('test',$1,'high',$2,null,$3)",[kind,key,JSON.stringify(payload)]);
 if(status==="failed")await db.query("update peragus_operator_notifications set status='failed',last_error='PROVIDER_REJECTED',updated_at=clock_timestamp() where dedupe_key=$1",[key]);
 if(status==="uncertain" || status==="accepted")await db.query("update peragus_operator_notifications set status='sending',attempts=1,first_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where dedupe_key=$1",[key]);
 if(status==="uncertain")await db.query("update peragus_operator_notifications set status='uncertain',last_error='PROVIDER_UNCONFIRMED',updated_at=clock_timestamp() where dedupe_key=$1",[key]);
 if(status==="accepted")await db.query("update peragus_operator_notifications set status='accepted',provider_email_id='synthetic-id',accepted_at=clock_timestamp(),updated_at=clock_timestamp() where dedupe_key=$1",[key]);
 return key;
}

beforeAll(async()=>{await migrateAll(db);await db.exec("insert into peragus_database_environment(environment) values('test')");},60000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});

describe("GET /v1/admin/operator-notifications",()=>{
 it("needs an allowlisted operator with AAL2 and a separate (non-customer) account",async()=>{
  const outsider=await appFor({id:randomUUID(),email:"x@example.test",assuranceLevel:"aal2",mfaVerifiedAt:Math.floor(Date.now()/1000)});
  const r1=await outsider.inject({method:"GET",url,headers});
  expect(r1.statusCode).toBe(403);expect(r1.json().error.code).toBe("WITHDRAWAL_OPERATOR_REQUIRED");
  const aal1=await appFor({id:operatorId,email:"operator@example.test",assuranceLevel:"aal1"});
  const r2=await aal1.inject({method:"GET",url,headers});
  expect(r2.statusCode).toBe(403);expect(r2.json().error.code).toBe("WITHDRAWAL_OPERATOR_MFA_REQUIRED");
  const anonymous=await appFor(operator);
  expect((await anonymous.inject({method:"GET",url})).statusCode).toBe(401);
  // A customer account is never an operator.
  const owner=randomUUID();
  await customers.createOrGet({ownerUserId:owner,type:"pf",displayName:"Synthetic name"});
  const customer=await appFor({id:owner,email:"c@example.test",assuranceLevel:"aal2",mfaVerifiedAt:Math.floor(Date.now()/1000)});
  const r3=await customer.inject({method:"GET",url,headers});
  expect(r3.statusCode).toBe(403);expect(r3.json().error.code).toBe("OPERATOR_ACCOUNT_SEPARATION_REQUIRED");
 });

 it("lists only uncertain/failed notifications, newest first, without payload or recipient addresses",async()=>{
  await notification("approval","pending");
  await notification("execution","accepted");
  const failed=await notification("stuck_operation","failed",{threshold:"sending_30m",reason_code:"SYNTHETIC_REASON"});
  const uncertain=await notification("refund_pending","uncertain",{refund_amount_brl:"1000.00"});
  // Stale MFA is fine for a read (AAL2 only, like the alerts list).
  const app=await appFor(operator);
  const r=await app.inject({method:"GET",url,headers});
  expect(r.statusCode).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  const body=r.json();
  expect(body.meta).toEqual({environment:"test",limit:100,status:"all"});
  const keys=new Set([failed,uncertain]);
  const ids=(await db.query<{id:string;dedupe_key:string}>("select id,dedupe_key from peragus_operator_notifications")).rows;
  const ours=ids.filter(row=>keys.has(row.dedupe_key)).map(row=>row.id);
  expect(body.data.map((n:{id:string})=>n.id).sort()).toEqual(ours.sort());
  expect(body.data.map((n:{status:string})=>n.status)).toEqual(["uncertain","uncertain","failed","failed"]);
  expect(Object.keys(body.data[0]).sort()).toEqual(["created_at","environment","first_attempt_at","id","kind","last_error","purchase_id","recipient_role","severity","status","updated_at"]);
  expect(body.data[0]).toMatchObject({kind:"refund_pending",severity:"high",last_error:"PROVIDER_UNCONFIRMED",environment:"test"});
  expect(body.data[2]).toMatchObject({kind:"stuck_operation",last_error:"PROVIDER_REJECTED",first_attempt_at:null});
  const text=JSON.stringify(body);
  expect(text).not.toMatch(/@|payload|dedupe|idempotency|synthetic|SYNTHETIC_REASON|1000\.00/i);
  const onlyFailed=(await app.inject({method:"GET",url:`${url}?status=failed`,headers})).json();
  expect(onlyFailed.data.every((n:{status:string})=>n.status==="failed")).toBe(true);
  expect(onlyFailed.meta.status).toBe("failed");
  for(const bad of ["status=pending","status=accepted","limit=5","status=failed&x=1"])
   expect((await app.inject({method:"GET",url:`${url}?${bad}`,headers})).statusCode,bad).toBe(400);
 });

 it("returns at most 100 rows",async()=>{
  for(let i=0;i<51;i++)await notification("approval","failed");
  const app=await appFor(operator);
  const body=(await app.inject({method:"GET",url,headers})).json();
  expect(body.data).toHaveLength(100);
 });

 it("is unavailable (503) without a configured service",async()=>{
  const app=await buildApp({customerAccess:{legal:allAcceptedLegal,customers,authenticate:async()=>operator as any}});apps.push(app);
  const r=await app.inject({method:"GET",url,headers});
  expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("OPERATOR_NOTIFICATIONS_UNAVAILABLE");
 });
});
