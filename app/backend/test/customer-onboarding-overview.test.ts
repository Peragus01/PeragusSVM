import {randomUUID} from "node:crypto";
import {readdir,readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresOnboardingOverviewRepository} from "../src/repositories/postgres-onboarding-overview.js";
import {CustomerOnboardingOverview} from "../src/onboarding/customer-onboarding-overview.js";
const db=new PGlite(),queries:string[]=[];
const pool={query:async(sql:string,params?:unknown[])=>{queries.push(sql);const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};}} as unknown as Pool;
const customers=new PostgresCustomerRepository(pool),repo=new PostgresOnboardingOverviewRepository(pool);
const actions={draft:false,terms:false,submission:false,verification:false,screening:false};
const service=new CustomerOnboardingOverview(repo,actions,()=>new Date("2026-10-20T12:00:00Z"));
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec("create role anon; create role authenticated;");const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),"utf8"));
},30000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
async function setup(type:"pf"|"pj"="pf"){
 const owner=randomUUID(),customer=(await customers.createOrGet({ownerUserId:owner,type,displayName:"Do not expose name"})).customer;
 return{owner,customer};
}
async function seed(s:Awaited<ReturnType<typeof setup>>){
 const id=s.customer.id,terms=randomUUID(),provider=`ozav_cus_${id.replaceAll("-","")}`;
 await db.query("insert into peragus_individual_onboarding_drafts(customer_id,encrypted_payload) values($1,$2)",[id,{ciphertext:"secret draft",cpf:"never select"}]);
 await db.query(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,terms_version,expires_at,accepted_at,encrypted_token,encrypted_acceptance)
  values($1,$2,$3,now(),'accepted','https://ozav.io/terms','2.0','2026-10-19T00:00:00Z','2026-10-18T00:00:00Z',$4,$5)`,[terms,id,randomUUID(),{secret:"ts_private"},{legal_name:"Private legal name"}]);
 await db.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode,provider_snapshot,refreshed_at)
 values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full',$7,now())`,[randomUUID(),id,terms,"a".repeat(64),randomUUID(),provider,{requirements_pending:false,due_count:0,missing_fields_count:0,documents_due_count:0}]);
 const observation={id:"ozav_vrf_test",customerId:provider,status:"completed",checks:{kyc_document:"pass",liveness:"pass",face_match:"pass",aml_name_screening:"not_started",private_data:"never expose"}};
 await db.query("insert into peragus_customer_verifications(customer_id,provider_customer_id,verification_id,observation,refreshed_at) values($1,$2,$3,$4,now())",[id,provider,`ozav_vrf_${id.replaceAll("-","")}`,observation]);
 await db.query("insert into peragus_customer_screenings(customer_id,provider_customer_id,idempotency_key,screening_id,observation,refreshed_at) values($1,$2,$3,$4,$5,now())",[id,provider,randomUUID(),`ozav_scr_${id.replaceAll("-","")}`,{status:"completed",result:"clear",lists:["sanctions","pep"],matchesCount:0,suggestedDecision:"clear",private_data:"not exposed"}]);
 return{terms,provider};
}
const path="/v1/me/onboarding/status",headers={authorization:"Bearer valid"};
async function appFor(s:Awaited<ReturnType<typeof setup>>,enabled=true){
 const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return{id:s.owner,email:"private@example.test"};}},...(enabled?{customerOnboardingOverview:service}:{})});apps.push(app);return app;
}
describe("stored onboarding overview",()=>{
 it("returns missing stages without provider calls, keys, decryption or writes",async()=>{
  const s=await setup();queries.length=0;const view=await service.read(s.customer);
  expect(queries).toHaveLength(1);expect(queries[0].trim().startsWith("select")).toBe(true);expect(queries[0]).not.toContain("encrypted_");
  expect(view.pending_steps).toEqual(["INDIVIDUAL_DRAFT_REQUIRED","PROVIDER_TERMS_REQUIRED","PROVIDER_SUBMISSION_REQUIRED"]);
  expect(view).toMatchObject({environment:"test",source:"stored_observations",operations_enabled:false,actions_enabled:actions});
 });
 it("consolidates recorded identity and independent screening while keeping all-checks unknown and financial gates closed",async()=>{
  const s=await setup();await seed(s);const app=await appFor(s),r=await app.inject({method:"GET",url:path,headers});
  expect(r.statusCode).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.json().data).toMatchObject({identity:{identity_outcome:"approved",all_checks_outcome:null,checks:{aml_name_screening:"not_started"}},screening:{result:"clear",matches_count:0},pending_steps:[],operations_enabled:false,operation_blockers:["SANDBOX_ONLY","FINANCIAL_OPERATIONS_DISABLED"]});
  for(const text of ["ts_private","Private legal name","private_data","secret draft","never select","Do not expose name","private@example.test"])expect(r.body).not.toContain(text);
  expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
  expect((await app.inject({method:"POST",url:"/v1/settlements",headers,payload:{}})).statusCode).toBe(403);
 });
 it("preserves submitted terms history after session renewal and does not demand renewal for a linked submission",async()=>{
  const s=await setup(),old=await seed(s);await db.query("update peragus_customer_terms_sessions set active=false where id=$1",[old.terms]);
  await db.query("insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until) values($1,$2,$3,now())",[randomUUID(),s.customer.id,randomUUID()]);
  const view=await service.read(s.customer);expect(view.provider_terms).toMatchObject({session_id:old.terms,state:"accepted",active:false,expired:true,linked_to_submission:true});
  expect(view.pending_steps).not.toContain("PROVIDER_TERMS_RENEWAL_REQUIRED");
 });
 it("reports active terms expiry before submission and uncertain sessions without inventing acceptance",async()=>{
  const s=await setup(),t=randomUUID();await db.query(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,encrypted_token,encrypted_acceptance,terms_version,expires_at,accepted_at) values($1,$2,$3,now(),'accepted','https://ozav.io/terms','{}','{}','2.0','2026-10-19T00:00:00Z','2026-10-18T00:00:00Z')`,[t,s.customer.id,randomUUID()]);
  expect((await service.read(s.customer)).pending_steps).toContain("PROVIDER_TERMS_RENEWAL_REQUIRED");
  await db.query("update peragus_customer_terms_sessions set state='uncertain',accepted_at=null where id=$1",[t]);expect((await service.read(s.customer)).pending_steps).toContain("PROVIDER_TERMS_RECOVERY_REQUIRED");
 });
 it("marks pending submission, unknown requirements and changed draft versions without silently resubmitting",async()=>{
  const s=await setup();await seed(s);await db.query("update peragus_individual_onboarding_drafts set version=2 where customer_id=$1",[s.customer.id]);
  await db.query("update peragus_customer_onboarding_submissions set provider_snapshot=null where customer_id=$1",[s.customer.id]);
  let view=await service.read(s.customer);expect(view.draft?.matches_submitted_version).toBe(false);expect(view.pending_steps).toContain("PROVIDER_REQUIREMENTS_UNKNOWN");
  await db.query("delete from peragus_customer_verifications where customer_id=$1",[s.customer.id]);await db.query("delete from peragus_customer_screenings where customer_id=$1",[s.customer.id]);
  await db.query("update peragus_customer_onboarding_submissions set state='pending',provider_customer_id=null where customer_id=$1",[s.customer.id]);view=await service.read(s.customer);expect(view.pending_steps).toContain("PROVIDER_SUBMISSION_PENDING");
 });
 it("surfaces provider rejection or mode changes independently of older successful identity evidence",async()=>{
  const s=await setup();await seed(s);
  await db.query("update peragus_customer_onboarding_submissions set provider_status='rejected',verification_mode='reliance' where customer_id=$1",[s.customer.id]);
  const view=await service.read(s.customer);expect(view.identity?.identity_outcome).toBe("approved");
  expect(view.pending_steps).toContain("PROVIDER_STATUS_NOT_APPROVED");expect(view.pending_steps).toContain("PROVIDER_VERIFICATION_MODE_REVIEW_REQUIRED");expect(view.operations_enabled).toBe(false);
 });
 it("keeps failed, review, pending and absent identity/screening evidence distinct",async()=>{
  const s=await setup();await seed(s);
  await db.query(`update peragus_customer_verifications set observation=jsonb_set(observation,'{checks,kyc_document}','"fail"') where customer_id=$1`,[s.customer.id]);
  await db.query(`update peragus_customer_screenings set observation=jsonb_set(observation,'{result}','"review"') where customer_id=$1`,[s.customer.id]);
  let view=await service.read(s.customer);expect(view.pending_steps).toContain("IDENTITY_VERIFICATION_REJECTED");expect(view.pending_steps).toContain("SCREENING_REVIEW_REQUIRED");
  await db.query(`update peragus_customer_verifications set observation=jsonb_set(observation,'{checks,kyc_document}','"review"') where customer_id=$1`,[s.customer.id]);
  await db.query(`update peragus_customer_screenings set observation=jsonb_set(observation,'{status}','"pending"') where customer_id=$1`,[s.customer.id]);
  view=await service.read(s.customer);expect(view.identity?.identity_outcome).toBeNull();expect(view.pending_steps).toContain("IDENTITY_VERIFICATION_PENDING");expect(view.pending_steps).toContain("SCREENING_PENDING");
  await db.query("delete from peragus_customer_verifications where customer_id=$1",[s.customer.id]);await db.query("delete from peragus_customer_screenings where customer_id=$1",[s.customer.id]);
  view=await service.read(s.customer);expect(view.pending_steps).toContain("IDENTITY_VERIFICATION_REQUIRED");expect(view.pending_steps).toContain("SCREENING_REQUIRED");
 });
 it("does not interpret clear without suggested decision or with contradictory matches as ready evidence",async()=>{
  const s=await setup();await seed(s);await db.query("update peragus_customer_screenings set observation=observation-'suggestedDecision' where customer_id=$1",[s.customer.id]);
  expect((await service.read(s.customer)).pending_steps).toContain("SCREENING_REVIEW_REQUIRED");
  await db.query(`update peragus_customer_screenings set observation=jsonb_set(observation,'{matchesCount}','1') where customer_id=$1`,[s.customer.id]);expect((await service.read(s.customer)).pending_steps).toContain("SCREENING_REVIEW_REQUIRED");
 });
 it("isolates owners, disallows selector parameters and mutations, and enforces authentication, PF and feature gates",async()=>{
  const s=await setup(),other=await setup(),pj=await setup("pj");await seed(s);const app=await appFor(other);
  expect((await app.inject({method:"GET",url:path,headers})).json().data.identity).toBeNull();
  expect((await app.inject({method:"GET",url:`${path}?customer_id=${s.customer.id}`,headers})).statusCode).toBe(400);
  expect((await app.inject({method:"GET",url:path})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:path,headers,payload:{}})).statusCode).toBe(404);
  expect((await (await appFor(pj)).inject({method:"GET",url:path,headers})).statusCode).toBe(403);
  expect((await (await appFor(s,false)).inject({method:"GET",url:path,headers})).statusCode).toBe(503);
  await db.query("update peragus_customers set suspended=true where id=$1",[other.customer.id]);expect((await app.inject({method:"GET",url:path,headers})).statusCode).toBe(403);
 });
 it("fails closed on inconsistent bindings and persistence errors without leaking internals",async()=>{
  const s=await setup();await seed(s);await db.query("update peragus_customer_verifications set provider_customer_id='ozav_cus_wrong' where customer_id=$1",[s.customer.id]);
  const r=await (await appFor(s)).inject({method:"GET",url:path,headers});expect(r.statusCode).toBe(503);expect(r.body).not.toContain("ozav_cus_wrong");
  const broken=new CustomerOnboardingOverview({read:async()=>{throw new Error("postgres password=secret");}},actions);
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:s.owner,email:"private@example.test"})},customerOnboardingOverview:broken});apps.push(app);
  const err=await app.inject({method:"GET",url:path,headers});expect(err.statusCode).toBe(503);expect(err.body).not.toContain("password");
 });
});
