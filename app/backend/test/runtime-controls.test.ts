import { allAcceptedLegal } from "./helpers/legal-double.js";
import { enableRuntimeControls, pauseRuntimeControls } from "./helpers/runtime-controls.js";
import {randomUUID} from "node:crypto";
import {Keypair} from "@solana/web3.js";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresCustomerPurchaseIntentRepository} from "../src/repositories/postgres-customer-purchase-intents.js";
import {PostgresCustomerQuoteRepository} from "../src/repositories/postgres-customer-quotes.js";
import {PostgresCustomerPixRepository} from "../src/repositories/postgres-customer-sandbox-pix.js";
import {PostgresCustomerVerificationRepository} from "../src/repositories/postgres-customer-verification.js";
import {PostgresOnboardingSubmissionRepository} from "../src/repositories/postgres-onboarding-submission.js";
import {CustomerPurchaseIntentService} from "../src/purchases/customer-purchase-intents.js";
import {CustomerSandboxPixService} from "../src/purchases/customer-sandbox-pix.js";
import {CustomerQuoteService} from "../src/quotes/customer-quotes.js";
import {assertControlEnabled,OperationsPausedError,RuntimeControlService} from "../src/operations/runtime-controls.js";

vi.setConfig({testTimeout:60000});
const db=new PGlite();let connection=Promise.resolve();
const query=async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};};
// PGlite has one session: connections are handed out one at a time.
const pool={query,connect:async()=>{
 const previous=connection;let release!:()=>void;connection=new Promise<void>(resolve=>{release=resolve;});await previous;
 return{query,release};
}} as unknown as Pool;
const wide={maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}};
const customers=new PostgresCustomerRepository(pool),purchases=new CustomerPurchaseIntentService(new PostgresCustomerPurchaseIntentRepository(pool,"test",wide));
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
async function migrate(target:PGlite){
 await target.exec("create role anon; create role authenticated;");
 const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await target.exec(await readFile(new URL(f,dir),"utf8"));
}
beforeAll(async()=>{await migrate(db);await db.exec("insert into peragus_database_environment(environment) values('test')");},60000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
beforeEach(async()=>{await pauseRuntimeControls(db);});

async function setup(){
 const owner=randomUUID(),customer=(await customers.createOrGet({ownerUserId:owner,type:"pf",displayName:"Synthetic name"})).customer;
 const id=customer.id,provider=`ozav_cus_${id.replaceAll("-","")}`,terms=randomUUID(),wallet=Keypair.generate().publicKey.toBase58();
 await db.query(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,terms_version,expires_at,accepted_at,encrypted_token,encrypted_acceptance,environment)
 values($1,$2,$3,now(),'accepted','https://ozav.io/terms','2.0',now()-interval '1 day',now()-interval '2 days','{}','{}','test')`,[terms,id,randomUUID()]);
 await db.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode,provider_snapshot,snapshot_version,environment)
 values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full',$7,2,'test')`,[randomUUID(),id,terms,"a".repeat(64),randomUUID(),provider,{requirements_pending:false}]);
 await db.query("insert into peragus_customer_wallets(customer_id,wallet_address,proof_challenge_id,verified_at,proof_message,proof_signature,environment,network) values($1,$2,$3,now(),'proof message','proof signature','test','solana:devnet')",[id,wallet,randomUUID()]);
 await db.query("insert into peragus_customer_verifications(customer_id,provider_customer_id,verification_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,3,now(),'test')",[id,provider,`ozav_vrf_${id.replaceAll("-","")}`,{status:"completed",checks:{kyc_document:"pass",liveness:"pass",face_match:"pass",aml_name_screening:"not_started"}}]);
 await db.query("insert into peragus_customer_screenings(customer_id,provider_customer_id,idempotency_key,screening_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,$5,4,now(),'test')",[id,provider,randomUUID(),`ozav_scr_${id.replaceAll("-","")}`,{status:"completed",result:"clear",matchesCount:0,suggestedDecision:"clear",lists:["sanctions","pep"]}]);
 const quoteId=randomUUID(),providerQuoteId=`ozav_q_${quoteId.replaceAll("-","")}`;
 await db.query("insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,create_attempted,provider_quote_id,observation,environment) values($1,$2,$3,$4,'1000.00',true,$5,$6,'test')",
  [quoteId,id,randomUUID(),provider,providerQuoteId,{id:providerQuoteId,customerId:provider,rateType:"floating",rate:"0.2",source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"},spreadBps:0,rateWithoutSpread:"0.2",amountDeducted:null,expiresAt:null,createdAt:new Date().toISOString()}]);
 return{owner,customer,provider,wallet,quoteId,requestId:randomUUID()};
}
function quoteFixture(s:Awaited<ReturnType<typeof setup>>){
 let posts=0;
 const provider={
  getCustomerCapabilities:async()=>({environment:"test",entitlements:["customers","liquidity"],scopes:["customers:read","quotes:write"]}),
  getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
  createCustomerIndicativeQuote:async(customerId:string,amount:string)=>{posts++;return{id:`ozav_q_${randomUUID().replaceAll("-","")}`,customerId,rateType:"floating",rate:"0.2",
   source:{currency:"BRL",amount},target:{currency:"USDT",amount:"200.000000"},spreadBps:0,rateWithoutSpread:"0.2",amountDeducted:null,expiresAt:null,createdAt:new Date().toISOString()};},
 } as any;
 const submissions={find:async()=>({state:"linked",providerId:s.provider})} as any;
 return{service:new CustomerQuoteService(new PostgresCustomerQuoteRepository(pool,"test"),submissions,provider,"test"),posts:()=>posts};
}
function pixFixture(s:Awaited<ReturnType<typeof setup>>){
 let posts=0;
 const repo=new PostgresCustomerPixRepository(pool,"test");
 const provider={getCustomerCapabilities:async()=>({environment:"test",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
  getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
  getCustomerManagedWallet:async()=>"ozav_wal_testmanaged",
  createCustomerPixTransfer:async(input:any)=>{posts++;const id=`ozav_tr_${randomUUID().replaceAll("-","")}`;return{id,transfer:{id,status:"awaiting_payment",customerId:input.customerId,quoteId:input.quoteId,
   source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"sandbox-code",qrCodeImage:null,expiresAt:new Date(Date.now()+60000).toISOString()}},
   destination:{type:"wallet",walletId:"ozav_wal_testmanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
   amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}}};},
  getTransfer:async()=>{throw new Error("not used");}} as any;
 return{service:new CustomerSandboxPixService(repo,provider),posts:()=>posts};
}
const status=async(id:string)=>(await db.query<{status:string}>("select status from peragus_customer_purchase_intents where id=$1",[id])).rows[0]?.status;
const operatorId=randomUUID();
const fresh=()=>({id:operatorId,email:"operator@example.test",assuranceLevel:"aal2" as const,mfaVerifiedAt:Math.floor(Date.now()/1000)});
async function appFor(identity:object,extra:object={}){
 const app=await buildApp({operatorUserIds:new Set([operatorId]),runtimeControlService:new RuntimeControlService(pool,new Set([operatorId]),"test"),
  customerAccess:{legal:allAcceptedLegal,customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return identity as any;}},...extra});
 apps.push(app);return app;
}
const headers={authorization:"Bearer valid"};

describe("runtime kill switches",()=>{
 it("default after migration is disabled (fail closed)",async()=>{
  const fresh=new PGlite();
  try{
   await migrate(fresh);
   expect((await fresh.query("select key,environment,enabled from peragus_runtime_controls order by key,environment")).rows).toEqual(
    ["new_operations","onboarding","usdt_sends"].flatMap(key=>["live","test"].map(environment=>({key,environment,enabled:false}))));
   const client={query:(sql:string,params?:unknown[])=>fresh.query(sql,params)} as any;
   // No recorded environment: every switch reads as paused.
   for(const key of ["new_operations","usdt_sends","onboarding"] as const)await expect(assertControlEnabled(client,key)).rejects.toMatchObject({code:"OPERATIONS_PAUSED",key});
   await fresh.exec("insert into peragus_database_environment(environment) values('live')");
   for(const key of ["new_operations","usdt_sends","onboarding"] as const)await expect(assertControlEnabled(client,key)).rejects.toBeInstanceOf(OperationsPausedError);
   // Only the recorded environment's rows can change; rows are never deleted; events are append-only.
   await expect(fresh.query("update peragus_runtime_controls set enabled=true where environment='test'")).rejects.toThrow("ENVIRONMENT_MISMATCH");
   await expect(fresh.query("delete from peragus_runtime_controls")).rejects.toThrow("RUNTIME_CONTROLS_UNDELETABLE");
   await fresh.query("update peragus_runtime_controls set enabled=true where key='onboarding' and environment='live'");
   await expect(assertControlEnabled(client,"onboarding")).resolves.toBeUndefined();
   await fresh.query("insert into peragus_runtime_control_events(key,from_enabled,to_enabled,operator_user_id,reason,environment) values('onboarding',false,true,$1,'test','live')",[randomUUID()]);
   await expect(fresh.query("update peragus_runtime_control_events set reason='x'")).rejects.toThrow("RUNTIME_CONTROL_EVENTS_APPEND_ONLY");
   await expect(fresh.query("delete from peragus_runtime_control_events")).rejects.toThrow("RUNTIME_CONTROL_EVENTS_APPEND_ONLY");
   const rls=await fresh.query<{relname:string;relrowsecurity:boolean}>("select relname,relrowsecurity from pg_class where relname in ('peragus_runtime_controls','peragus_runtime_control_events') order by 1");
   expect(rls.rows).toEqual([{relname:"peragus_runtime_control_events",relrowsecurity:true},{relname:"peragus_runtime_controls",relrowsecurity:true}]);
   const grants=await fresh.query("select grantee,table_name from information_schema.role_table_grants where table_name in ('peragus_runtime_controls','peragus_runtime_control_events') and grantee in ('anon','authenticated','PUBLIC')");
   expect(grants.rows).toEqual([]);
  }finally{await fresh.close();}
 });

 it("paused new_operations refuses quotes and acceptance",async()=>{
  const s=await setup();
  await enableRuntimeControls(db,["usdt_sends","onboarding"]);
  const quotes=quoteFixture(s),quoteRequest=randomUUID();
  await expect(quotes.service.create(s.customer.id,quoteRequest,"1000.00")).rejects.toMatchObject({code:"OPERATIONS_PAUSED",key:"new_operations"});
  expect(quotes.posts()).toBe(0);
  expect((await db.query("select count(*)::int n from peragus_customer_indicative_quotes where customer_id=$1 and request_id=$2 and create_attempted",[s.customer.id,quoteRequest])).rows[0]).toEqual({n:0});
  await expect(purchases.record(s.customer.id,s.requestId,s.quoteId)).rejects.toMatchObject({code:"OPERATIONS_PAUSED",key:"new_operations"});
  expect((await db.query("select count(*)::int n from peragus_customer_purchase_intents where customer_id=$1",[s.customer.id])).rows[0]).toEqual({n:0});
  expect((await db.query("select count(*)::int n from peragus_operation_status_events where customer_id=$1",[s.customer.id])).rows[0]).toEqual({n:0});
  // A purchase accepted before the pause stays accepted; only its Pix create is refused.
  await enableRuntimeControls(db,["new_operations"]);
  const accepted=await purchases.record(s.customer.id,s.requestId,s.quoteId);
  await pauseRuntimeControls(db,["new_operations"]);
  const pix=pixFixture(s),pixRequest=randomUUID();
  await expect(pix.service.create(s.customer.id,pixRequest,accepted.data.id)).rejects.toMatchObject({code:"OPERATIONS_PAUSED",key:"new_operations"});
  expect(pix.posts()).toBe(0);expect(await status(accepted.data.id)).toBe("accepted");
  expect((await db.query("select count(*)::int n from peragus_customer_sandbox_pix where purchase_intent_id=$1",[accepted.data.id])).rows[0]).toEqual({n:0});
  // HTTP: 503 OPERATIONS_PAUSED naming the key, on the quote, accept and Pix routes.
  const app=await appFor({id:s.owner,email:"customer@example.test"},{customerQuoteService:quotes.service,customerPurchaseIntentService:purchases,customerSandboxPixService:pix.service});
  for(const [url,payload] of [["/v1/me/quotes",{request_id:randomUUID(),source_amount_brl:"1000.00"}],["/v1/me/purchase-intents",{request_id:randomUUID(),quote_id:s.quoteId}],
   ["/v1/me/pix",{request_id:randomUUID(),purchase_intent_id:accepted.data.id}]] as const){
   const r=await app.inject({method:"POST",url,headers,payload});
   expect(r.statusCode,url).toBe(503);expect(r.json(),url).toEqual({error:{code:"OPERATIONS_PAUSED",key:"new_operations",automatic_retry:false}});
  }
  expect(quotes.posts()+pix.posts()).toBe(0);
 });

 it("resuming lets the same operation proceed",async()=>{
  const s=await setup(),quotes=quoteFixture(s),pix=pixFixture(s),quoteRequest=randomUUID(),pixRequest=randomUUID();
  await expect(quotes.service.create(s.customer.id,quoteRequest,"1000.00")).rejects.toBeInstanceOf(OperationsPausedError);
  await expect(purchases.record(s.customer.id,s.requestId,s.quoteId)).rejects.toBeInstanceOf(OperationsPausedError);
  await enableRuntimeControls(db,["new_operations"]);
  const quote=await quotes.service.create(s.customer.id,quoteRequest,"1000.00");
  expect(quote.replayed).toBe(false);expect(quotes.posts()).toBe(1);
  const accepted=await purchases.record(s.customer.id,s.requestId,s.quoteId);
  expect(accepted.replayed).toBe(false);
  await pauseRuntimeControls(db,["new_operations"]);
  await expect(pix.service.create(s.customer.id,pixRequest,accepted.data.id)).rejects.toBeInstanceOf(OperationsPausedError);
  await enableRuntimeControls(db,["new_operations"]);
  const charge=await pix.service.create(s.customer.id,pixRequest,accepted.data.id);
  expect(charge.replayed).toBe(false);expect(pix.posts()).toBe(1);
  expect((await db.query("select create_attempted from peragus_customer_sandbox_pix where purchase_intent_id=$1",[accepted.data.id])).rows).toEqual([{create_attempted:true}]);
 });

 it("pauses onboarding submission and verification start, not reads",async()=>{
  const s=await setup(),submissions=new PostgresOnboardingSubmissionRepository(pool,"test"),verifications=new PostgresCustomerVerificationRepository(pool,"test");
  const other=(await setup()).customer;
  await db.query("delete from peragus_customer_verifications where customer_id=$1",[other.id]);
  await verifications.reserve(other.id,`ozav_cus_${other.id.replaceAll("-","")}`);
  await expect(verifications.claimCreate(other.id)).rejects.toMatchObject({code:"OPERATIONS_PAUSED",key:"onboarding"});
  expect((await verifications.find(other.id))?.createAttempted).toBe(false);
  const submission=(await submissions.find(s.customer.id))!;
  await expect(submissions.claimAttempt(submission)).rejects.toMatchObject({code:"OPERATIONS_PAUSED",key:"onboarding"});
  await enableRuntimeControls(db,["onboarding"]);
  await expect(verifications.claimCreate(other.id)).resolves.toBe(true);
  await expect(submissions.claimAttempt(submission)).resolves.toBeUndefined();
 });

 it("change is audited and needs fresh MFA",async()=>{
  const s=await setup();
  await enableRuntimeControls(db,["new_operations"]);
  const accepted=await purchases.record(s.customer.id,s.requestId,s.quoteId);
  const url="/v1/admin/runtime-controls",payload={key:"new_operations",enabled:false,reason:"Pausing new operations during provider incident."};
  // Not an operator, then an operator without a fresh TOTP.
  expect((await (await appFor({id:randomUUID(),email:"x@example.test",assuranceLevel:"aal2",mfaVerifiedAt:Math.floor(Date.now()/1000)})).inject({method:"GET",url,headers})).json().error.code).toBe("WITHDRAWAL_OPERATOR_REQUIRED");
  const stale=await appFor({...fresh(),mfaVerifiedAt:Math.floor(Date.now()/1000)-301});
  for(const r of [await stale.inject({method:"GET",url,headers}),await stale.inject({method:"PUT",url,headers,payload})]){
   expect(r.statusCode).toBe(403);expect(r.json().error.code).toBe("OPERATOR_MFA_STALE");
  }
  expect((await db.query("select count(*)::int n from peragus_runtime_control_events")).rows[0]).toEqual({n:0});
  // A customer account is never an operator.
  const customerOperator=await appFor({id:s.owner,email:"c@example.test",assuranceLevel:"aal2",mfaVerifiedAt:Math.floor(Date.now()/1000)});
  expect((await customerOperator.inject({method:"GET",url,headers})).json().error.code).toBe("OPERATOR_ACCOUNT_SEPARATION_REQUIRED");
  const app=await appFor(fresh());
  for(const bad of [{...payload,reason:""},{...payload,reason:"x".repeat(501)},{...payload,reason:"line\nbreak"},{key:"new_operations",enabled:false},{...payload,key:"refunds"},{...payload,extra:1}])
   expect((await app.inject({method:"PUT",url,headers,payload:bad})).statusCode).toBe(400);
  const list=await app.inject({method:"GET",url,headers});
  expect(list.statusCode).toBe(200);expect(list.headers["cache-control"]).toBe("no-store");
  expect(list.json().data).toMatchObject({environment:"test",controls:[{key:"new_operations",enabled:true},{key:"usdt_sends",enabled:false},{key:"onboarding",enabled:false}]});
  const put=await app.inject({method:"PUT",url,headers,payload});
  expect(put.statusCode).toBe(200);
  expect(put.json().data).toMatchObject({key:"new_operations",enabled:false,changed:true,updated_by:operatorId,environment:"test"});
  const again=await app.inject({method:"PUT",url,headers,payload});
  expect(again.json().data).toMatchObject({key:"new_operations",enabled:false,changed:false});
  expect((await db.query("select key,from_enabled,to_enabled,operator_user_id,reason,environment from peragus_runtime_control_events")).rows).toEqual([
   {key:"new_operations",from_enabled:true,to_enabled:false,operator_user_id:operatorId,reason:payload.reason,environment:"test"}]);
  // The pause cancels nothing: the accepted operation keeps its status and status log.
  expect(await status(accepted.data.id)).toBe("accepted");
  expect((await db.query("select count(*)::int n from peragus_operation_status_events where purchase_id=$1",[accepted.data.id])).rows[0]).toEqual({n:1});
  await expect(new RuntimeControlService(pool,new Set([operatorId]),"test").list(fresh())).resolves.toMatchObject({controls:expect.arrayContaining([expect.objectContaining({key:"new_operations",enabled:false})])});
  const on=await app.inject({method:"PUT",url,headers,payload:{key:"new_operations",enabled:true,reason:"Incident resolved."}});
  expect(on.json().data).toMatchObject({enabled:true,changed:true});
  expect((await db.query("select count(*)::int n from peragus_runtime_control_events")).rows[0]).toEqual({n:2});
 });
});
