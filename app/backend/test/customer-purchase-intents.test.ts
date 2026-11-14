import { enableRuntimeControls } from "./helpers/runtime-controls.js";
import { allAcceptedLegal } from "./helpers/legal-double.js";
import {randomUUID} from "node:crypto";
import {Keypair} from "@solana/web3.js";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresCustomerPurchaseIntentRepository} from "../src/repositories/postgres-customer-purchase-intents.js";
import {CustomerPurchaseIntentService,PurchaseIntentError} from "../src/purchases/customer-purchase-intents.js";
const db=new PGlite();let failInsert=false;let connection=Promise.resolve();
const query=async(sql:string,params?:unknown[])=>{
 if(failInsert && sql.startsWith("insert into peragus_customer_purchase_intents")){failInsert=false;throw new Error("private database details");}
 const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};
};
// PGlite has one session: connections are handed out one at a time.
const pool={query,connect:async()=>{
 const previous=connection;let release!:()=>void;connection=new Promise<void>(resolve=>{release=resolve;});await previous;
 return{query,release};
}} as unknown as Pool;
const wide={maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}};
const customers=new PostgresCustomerRepository(pool),repo=new PostgresCustomerPurchaseIntentRepository(pool,"test",wide),service=new CustomerPurchaseIntentService(repo);
const OPEN_SQL="status not in ('delivered_verified','expired','failed','refunded')";
const closeAllOpen=()=>db.query("update peragus_customer_purchase_intents set status='expired' where status in ('accepted','awaiting_pix')");
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),"utf8"));
 await db.exec("insert into peragus_database_environment(environment) values('test')");
 // Runtime kill switches start OFF (054); this suite performs guarded actions.
 await enableRuntimeControls(db);
},30000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
async function setup(type:"pf"|"pj"="pf"){
 const owner=randomUUID(),customer=(await customers.createOrGet({ownerUserId:owner,type,displayName:"Synthetic name"})).customer;
 const id=customer.id,provider=`ozav_cus_${id.replaceAll("-","")}`,terms=randomUUID(),wallet=Keypair.generate().publicKey.toBase58();
 await db.query(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,terms_version,expires_at,accepted_at,encrypted_token,encrypted_acceptance,environment)
 values($1,$2,$3,now(),'accepted','https://ozav.io/terms','2.0',now()-interval '1 day',now()-interval '2 days','{}','{}','test')`,[terms,id,randomUUID()]);
 await db.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode,provider_snapshot,snapshot_version,environment)
 values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full',$7,2,'test')`,[randomUUID(),id,terms,"a".repeat(64),randomUUID(),provider,{requirements_pending:false}]);
 await db.query("insert into peragus_customer_wallets(customer_id,wallet_address,proof_challenge_id,verified_at,proof_message,proof_signature,environment,network) values($1,$2,$3,now(),'private proof message','private proof signature','test','solana:devnet')",[id,wallet,randomUUID()]);
 await db.query("insert into peragus_customer_verifications(customer_id,provider_customer_id,verification_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,3,now(),'test')",[id,provider,`ozav_vrf_${id.replaceAll("-","")}`,{status:"completed",checks:{kyc_document:"pass",liveness:"pass",face_match:"pass",aml_name_screening:"not_started"}}]);
 await db.query("insert into peragus_customer_screenings(customer_id,provider_customer_id,idempotency_key,screening_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,$5,4,now(),'test')",[id,provider,randomUUID(),`ozav_scr_${id.replaceAll("-","")}`,{status:"completed",result:"clear",matchesCount:0,suggestedDecision:"clear",lists:["sanctions","pep"]}]);
 const makeQuote=async()=>{
  const localId=randomUUID(),providerId=`ozav_q_${localId.replaceAll("-","")}`,observation={id:providerId,customerId:provider,rateType:"floating",rate:"0.2",source:{currency:"BRL",amount:"500.00"},target:{currency:"USDT",amount:"100.000000"},spreadBps:0,rateWithoutSpread:"0.2",amountDeducted:null,expiresAt:null,createdAt:new Date().toISOString(),private_data:"never return"};
  await db.query("insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,create_attempted,provider_quote_id,observation,environment) values($1,$2,$3,$4,'500.00',true,$5,$6,'test')",[localId,id,randomUUID(),provider,providerId,observation]);return localId;
 };
 const actualQuoteId=await makeQuote();
 return{owner,customer,provider,terms,wallet,quoteId:actualQuoteId,makeQuote,requestId:randomUUID()};
}
async function appFor(s:Awaited<ReturnType<typeof setup>>,enabled=true){
 const app=await buildApp({customerAccess:{ legal: allAcceptedLegal,customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return{id:s.owner,email:"private@example.test"};}},...(enabled?{customerPurchaseIntentService:service}:{})});apps.push(app);return app;
}
const path="/v1/me/purchase-intents",headers={authorization:"Bearer valid"};
describe("record-only sandbox purchase intents",()=>{
 it("derives price, destination and evidence from owned records without creating settlement/funding or exposing secrets",async()=>{
  const s=await setup(),app=await appFor(s),r=await app.inject({method:"POST",url:path,headers,payload:{request_id:s.requestId,quote_id:s.quoteId}});
  expect(r.statusCode).toBe(201);expect(r.headers["cache-control"]).toBe("no-store");expect(r.headers.location).toBe(`${path}/${r.json().data.id}`);
  expect(r.json().data).toMatchObject({source:{currency:"BRL",amount:"500.00"},estimated_target:{currency:"USDT",amount:"100.000000",chain:"solana"},destination:{wallet_address:s.wallet,proof_network:"solana:devnet"},record_only:true,executable:false,funding_started:false,job_enqueued:false,operations_enabled:false});
  for(const text of ["private proof","never return","Synthetic name","private@example.test",s.provider])expect(r.body).not.toContain(text);
  const row=(await db.query("select * from peragus_customer_purchase_intents where id=$1",[r.json().data.id])).rows[0] as any;
  expect(row.evidence_snapshot).toMatchObject({registration_snapshot_version:2,verification_revision:3,screening_revision:4,terms_session_id:s.terms});
  expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");expect((await db.query("select count(*) as n from settlements")).rows[0]).toEqual({n:0});
  expect((await app.inject({method:"POST",url:"/v1/settlements",headers,payload:{}})).statusCode).toBe(403);
 });
 it("replays exactly, reads saved state and conflicts when the same request changes quote",async()=>{
  const s=await setup(),first=await service.record(s.customer.id,s.requestId,s.quoteId),secondQuote=await s.makeQuote();
  const again=await service.record(s.customer.id,s.requestId,s.quoteId);expect(again.replayed).toBe(true);expect(again.data).toEqual(first.data);
  expect(await service.read(s.customer.id,first.data.id)).toEqual(first.data);
  await expect(service.record(s.customer.id,s.requestId,secondQuote)).rejects.toThrow("PURCHASE_IDEMPOTENCY_CONFLICT");
 });
 it("prevents two request IDs from creating two intents for one quote, including competing calls",async()=>{
  const s=await setup();const results=await Promise.allSettled([service.record(s.customer.id,s.requestId,s.quoteId),service.record(s.customer.id,randomUUID(),s.quoteId)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect((await db.query("select count(*) as n from peragus_customer_purchase_intents where customer_id=$1",[s.customer.id])).rows[0]).toEqual({n:1});
 });
 it("allows per-customer request IDs and isolates foreign quote and intent reads",async()=>{
  const s=await setup(),other=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId),two=await service.record(other.customer.id,s.requestId,other.quoteId);
  expect(two.data.id).not.toBe(one.data.id);await expect(service.read(other.customer.id,one.data.id)).rejects.toThrow("PURCHASE_INTENT_NOT_FOUND");
  await expect(service.record(other.customer.id,randomUUID(),s.quoteId)).rejects.toThrow("PURCHASE_QUOTE_NOT_FOUND");
  const r=await (await appFor(other)).inject({method:"GET",url:`${path}/${one.data.id}`,headers});expect(r.statusCode).toBe(404);
 });
 it("freezes the reference and destination on replay even if later observations or the stored wallet change",async()=>{
  const s=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId);
  await db.query("update peragus_customer_wallets set wallet_address=$2 where customer_id=$1",[s.customer.id,Keypair.generate().publicKey.toBase58()]);
  await db.query("update peragus_customer_onboarding_submissions set provider_status='rejected' where customer_id=$1",[s.customer.id]);
  expect((await service.record(s.customer.id,s.requestId,s.quoteId)).data).toEqual(one.data);
  const fresh=await s.makeQuote();await expect(service.record(s.customer.id,randomUUID(),fresh)).rejects.toThrow("PURCHASE_PREREQUISITES_NOT_RECORDED");
 });
 it("requires a linked approved full-mode provider snapshot without pending or unknown requirements",async()=>{
  const s=await setup();for(const sql of ["provider_status='rejected'","provider_status='approved',verification_mode='reliance'","verification_mode='full',provider_snapshot=null","provider_snapshot='{\"requirements_pending\":true}'"]){
   await db.query(`update peragus_customer_onboarding_submissions set ${sql} where customer_id=$1`,[s.customer.id]);await expect(service.record(s.customer.id,randomUUID(),s.quoteId)).rejects.toThrow("PURCHASE_PREREQUISITES_NOT_RECORDED");
  }
 });
 it("requires captured identity and separate completed clear screening, without overriding explicit AML review/failure",async()=>{
  const s=await setup();for(const value of ["fail","review","not_started"]){
   await db.query("update peragus_customer_verifications set observation=jsonb_set(observation,'{checks,kyc_document}',$2::jsonb) where customer_id=$1",[s.customer.id,JSON.stringify(value)]);await expect(service.record(s.customer.id,randomUUID(),s.quoteId)).rejects.toThrow("PURCHASE_PREREQUISITES_NOT_RECORDED");
  }
  await db.query(`update peragus_customer_verifications set observation=jsonb_set(observation,'{checks,kyc_document}','"pass"') where customer_id=$1`,[s.customer.id]);
  for(const value of ["fail","review"]){await db.query("update peragus_customer_verifications set observation=jsonb_set(observation,'{checks,aml_name_screening}',$2::jsonb) where customer_id=$1",[s.customer.id,JSON.stringify(value)]);await expect(service.record(s.customer.id,randomUUID(),s.quoteId)).rejects.toThrow();}
  await db.query(`update peragus_customer_verifications set observation=jsonb_set(observation,'{checks,aml_name_screening}','"not_started"') where customer_id=$1`,[s.customer.id]);
  await db.query(`update peragus_customer_screenings set observation=jsonb_set(observation,'{result}','"review"') where customer_id=$1`,[s.customer.id]);await expect(service.record(s.customer.id,randomUUID(),s.quoteId)).rejects.toThrow("PURCHASE_PREREQUISITES_NOT_RECORDED");
 });
 it("requires a proved wallet and recorded accepted terms; historical accepted-session expiry alone does not execute or erase the record",async()=>{
  const s=await setup();await db.query("delete from peragus_customer_wallets where customer_id=$1",[s.customer.id]);await expect(service.record(s.customer.id,s.requestId,s.quoteId)).rejects.toThrow("PURCHASE_PREREQUISITES_NOT_RECORDED");
  const terms=await setup();await db.query("update peragus_customer_terms_sessions set state='uncertain',accepted_at=null where id=$1",[terms.terms]);await expect(service.record(terms.customer.id,terms.requestId,terms.quoteId)).rejects.toThrow("PURCHASE_PREREQUISITES_NOT_RECORDED");
 });
 it("rejects uncertain, misbound, wrong-pair or locked quote records",async()=>{
  const changes=[{path:["customerId"],value:"ozav_cus_foreign"},{path:["target","currency"],value:"USDC"},
   {path:["source","currency"],value:"USD"},{path:["rateType"],value:"locked"},{path:["id"],value:"ozav_q_other"}];
  for(const change of changes){
   const s=await setup();await db.query("update peragus_customer_indicative_quotes set observation=jsonb_set(observation,$2::text[],$3::jsonb) where id=$1",[s.quoteId,change.path,JSON.stringify(change.value)]);
   await expect(service.record(s.customer.id,s.requestId,s.quoteId)).rejects.toThrow("PURCHASE_PREREQUISITES_NOT_RECORDED");
  }
  const uncertain=await setup();await db.query("update peragus_customer_indicative_quotes set provider_quote_id=null,observation=null where id=$1",[uncertain.quoteId]);
  await expect(service.record(uncertain.customer.id,uncertain.requestId,uncertain.quoteId)).rejects.toThrow("PURCHASE_PREREQUISITES_NOT_RECORDED");
 });
 it("keeps auth, PF, suspension, disabled, strict input and storage-error gates",async()=>{
  const s=await setup(),pj=await setup("pj"),app=await appFor(s),payload={request_id:s.requestId,quote_id:s.quoteId};
  expect((await app.inject({method:"POST",url:path,payload})).statusCode).toBe(401);expect((await (await appFor(pj)).inject({method:"POST",url:path,headers,payload})).statusCode).toBe(403);expect((await (await appFor(s,false)).inject({method:"POST",url:path,headers,payload})).statusCode).toBe(503);
  for(const extra of [{source_amount_brl:"1"},{wallet_address:"arbitrary"},{customer_id:s.customer.id},{operations_enabled:true}])expect((await app.inject({method:"POST",url:path,headers,payload:{...payload,...extra}})).statusCode).toBe(400);
  const malformed=await app.inject({method:"POST",url:path,headers:{...headers,"content-type":"application/json"},payload:'{"private":"secret",'});expect(malformed.statusCode).toBe(400);expect(malformed.body).not.toContain("secret");
  failInsert=true;const failure=await app.inject({method:"POST",url:path,headers,payload});expect(failure.statusCode).toBe(503);expect(failure.body).not.toContain("private database");
  await db.query("update peragus_customers set suspended=true where id=$1",[s.customer.id]);expect((await app.inject({method:"POST",url:path,headers,payload})).statusCode).toBe(403);
 });
 it("enforces record-only/test database constraints, owner foreign key and RLS",async()=>{
  const s=await setup(),other=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId);
  for(const assignment of ["environment='live'","record_only=false","state='funded'","wallet_proof_network='solana:mainnet'",`customer_id='${other.customer.id}'`])await expect(db.query(`update peragus_customer_purchase_intents set ${assignment} where id=$1`,[one.data.id])).rejects.toThrow();
  const r=await db.query("select relrowsecurity,has_table_privilege('anon','peragus_customer_purchase_intents','SELECT') as anon_select,has_table_privilege('authenticated','peragus_customer_purchase_intents','INSERT') as auth_insert from pg_class where relname='peragus_customer_purchase_intents'");expect(r.rows[0]).toEqual({relrowsecurity:true,anon_select:false,auth_insert:false});
 });
});

describe("operation status, limits and concurrency",()=>{
 it("records the purchase at accepted with an initial status event",async()=>{
  const s=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId);
  expect(one.data.status).toBe("accepted");
  const events=(await db.query("select from_status,to_status,actor,environment from peragus_operation_status_events where purchase_id=$1",[one.data.id])).rows;
  expect(events).toEqual([{from_status:null,to_status:"accepted",actor:`customer:${s.customer.id}`,environment:"test"}]);
 });
 it("rejects an invalid transition",async()=>{
  const s=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId);
  await expect(db.query("update peragus_customer_purchase_intents set status='sent' where id=$1",[one.data.id])).rejects.toThrow("OPERATION_INVALID_TRANSITION");
  await expect(repo.transitionOperation(one.data.id,"sent","system","synthetic")).rejects.toThrow("OPERATION_INVALID_TRANSITION");
  expect((await db.query("select status from peragus_customer_purchase_intents where id=$1",[one.data.id])).rows).toEqual([{status:"accepted"}]);
 });
 it("transitionOperation moves along the lifecycle, stamps the change and appends one event per change",async()=>{
  const s=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId);
  const before=(await db.query<{status_changed_at:Date}>("select status_changed_at from peragus_customer_purchase_intents where id=$1",[one.data.id])).rows[0]!.status_changed_at;
  expect(await repo.transitionOperation(one.data.id,"awaiting_pix","system:pix","pix transfer created")).toMatchObject({from:"accepted",to:"awaiting_pix",changed:true});
  expect(await repo.transitionOperation(one.data.id,"awaiting_pix","system:pix","duplicate webhook")).toMatchObject({from:"awaiting_pix",to:"awaiting_pix",changed:false});
  const row=(await db.query<{status:string;status_changed_at:Date}>("select status,status_changed_at from peragus_customer_purchase_intents where id=$1",[one.data.id])).rows[0]!;
  expect(row.status).toBe("awaiting_pix");expect(new Date(row.status_changed_at).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  const events=(await db.query("select from_status,to_status,actor,reason from peragus_operation_status_events where purchase_id=$1 order by id",[one.data.id])).rows;
  expect(events).toEqual([{from_status:null,to_status:"accepted",actor:`customer:${s.customer.id}`,reason:"quote_accepted"},{from_status:"accepted",to_status:"awaiting_pix",actor:"system:pix",reason:"pix transfer created"}]);
  await expect(repo.transitionOperation(randomUUID(),"failed","system","synthetic")).rejects.toThrow("PURCHASE_INTENT_NOT_FOUND");
  await expect(repo.transitionOperation(one.data.id,"failed","","synthetic")).rejects.toThrow();
  await expect(new PostgresCustomerPurchaseIntentRepository(pool,"live",wide).transitionOperation(one.data.id,"failed","system","x")).rejects.toThrow("PURCHASE_INTENT_NOT_FOUND");
 });
 it("copies the locked USDT amount and terms version from the quote at accept time and never lets them change",async()=>{
  const s=await setup();
  await db.query("update peragus_customer_indicative_quotes set facility_terms_version='2.0',locked_usdt_amount='99.500000' where id=$1",[s.quoteId]);
  const one=await service.record(s.customer.id,s.requestId,s.quoteId);
  const row=(await db.query<{facility_terms_version:string|null;locked_usdt_amount:string}>("select facility_terms_version,locked_usdt_amount from peragus_customer_purchase_intents where id=$1",[one.data.id])).rows[0]!;
  expect(row).toEqual({facility_terms_version:"2.0",locked_usdt_amount:"99.500000"});
  // Later changes to the quote never reach the accepted purchase.
  await db.query("update peragus_customer_indicative_quotes set locked_usdt_amount='1.000000' where id=$1",[s.quoteId]);
  expect((await db.query("select locked_usdt_amount from peragus_customer_purchase_intents where id=$1",[one.data.id])).rows).toEqual([{locked_usdt_amount:"99.500000"}]);
  for(const assignment of ["facility_terms_version='9.9'","facility_terms_version=null","locked_usdt_amount=1","locked_usdt_amount=null",`evidence_snapshot='{"x":1}'`])
   await expect(db.query(`update peragus_customer_purchase_intents set ${assignment} where id=$1`,[one.data.id]),assignment).rejects.toThrow("PURCHASE_FINANCIAL_FIELDS_IMMUTABLE");
 });
 it("in test mode the locked amount is the quote target and the terms version stays null",async()=>{
  const s=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId);
  expect((await db.query("select facility_terms_version,locked_usdt_amount from peragus_customer_purchase_intents where id=$1",[one.data.id])).rows).toEqual([{facility_terms_version:null,locked_usdt_amount:"100.000000"}]);
 });
 it("rejects updating the locked USDT amount and the other accepted financial fields",async()=>{
  const s=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId),other=await s.makeQuote();
  for(const assignment of ["estimated_target_amount_usdt=99","source_amount_brl=1","quote_snapshot='{}'",`quote_id='${other}'`,
   `wallet_address='${Keypair.generate().publicKey.toBase58()}'`,"wallet_verified_at=now()","provider_customer_id='ozav_cus_other'"])
   await expect(db.query(`update peragus_customer_purchase_intents set ${assignment} where id=$1`,[one.data.id]),assignment).rejects.toThrow("PURCHASE_FINANCIAL_FIELDS_IMMUTABLE");
  await db.query("update peragus_customer_purchase_intents set status='expired' where id=$1",[one.data.id]);
  await expect(db.query("update peragus_customer_purchase_intents set estimated_target_amount_usdt=99 where id=$1",[one.data.id])).rejects.toThrow("PURCHASE_FINANCIAL_FIELDS_IMMUTABLE");
 });
 it("rejects a second open operation for the same customer until the first is terminal",async()=>{
  const s=await setup(),one=await service.record(s.customer.id,s.requestId,s.quoteId),second=await s.makeQuote();
  const refused=await service.record(s.customer.id,randomUUID(),second).catch(e=>e);
  expect(refused).toBeInstanceOf(PurchaseIntentError);expect(refused.code).toBe("PURCHASE_CUSTOMER_HAS_OPEN_OPERATION");
  const r=await (await appFor(s)).inject({method:"POST",url:path,headers,payload:{request_id:randomUUID(),quote_id:second}});
  expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("PURCHASE_CUSTOMER_HAS_OPEN_OPERATION");
  // The partial unique index enforces it even without the repository.
  await expect(db.query(`insert into peragus_customer_purchase_intents(id,customer_id,request_id,quote_id,provider_customer_id,source_amount_brl,estimated_target_amount_usdt,quote_snapshot,wallet_address,wallet_verified_at,evidence_snapshot,environment,wallet_proof_network)
   values($1,$2,$3,$4,$5,'500.00','100.000000','{}',$6,now(),'{}','test','solana:devnet')`,[randomUUID(),s.customer.id,randomUUID(),second,s.provider,s.wallet])).rejects.toThrow(/peragus_purchase_one_open_per_customer/);
  await repo.transitionOperation(one.data.id,"expired","system","synthetic expiry");
  expect((await service.record(s.customer.id,randomUUID(),second)).data.status).toBe("accepted");
 });
 it("rejects a second open operation globally when cap is 1, including competing calls",async()=>{
  await closeAllOpen();
  const capped=new PostgresCustomerPurchaseIntentRepository(pool,"test",{...wide,maxOpenGlobal:1}),a=await setup(),b=await setup(),c=await setup();
  const results=await Promise.allSettled([capped.record(a.customer.id,a.requestId,a.quoteId),capped.record(b.customer.id,b.requestId,b.quoteId)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const rejected=results.find(r=>r.status==="rejected") as PromiseRejectedResult;expect(rejected.reason.code).toBe("PURCHASE_GLOBAL_CAPACITY_REACHED");
  expect((await db.query(`select count(*)::int n from peragus_customer_purchase_intents where ${OPEN_SQL}`)).rows).toEqual([{n:1}]);
  await expect(capped.record(c.customer.id,c.requestId,c.quoteId)).rejects.toThrow("PURCHASE_GLOBAL_CAPACITY_REACHED");
  // A replay of the accepted request is not a new operation.
  const winner=results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<{record:{id:string;requestId:string;quoteId:string;customerId:string}}>;
  const w=winner.value.record;expect((await capped.record(w.customerId,w.requestId,w.quoteId)).replayed).toBe(true);
  await closeAllOpen();expect((await capped.record(c.customer.id,c.requestId,c.quoteId)).replayed).toBe(false);
  await closeAllOpen();
 });
 it("enforces the configured BRL range when recording, so target-amount quotes cannot bypass it",async()=>{
  const s=await setup(),strict=new PostgresCustomerPurchaseIntentRepository(pool,"test",{maxOpenGlobal:1000,limits:{minCents:100000n,maxCents:100000n}});
  await expect(strict.record(s.customer.id,s.requestId,s.quoteId)).rejects.toThrow("QUOTE_AMOUNT_OUT_OF_RANGE");
  expect((await db.query("select count(*)::int n from peragus_customer_purchase_intents where customer_id=$1",[s.customer.id])).rows).toEqual([{n:0}]);
 });
 it("runs accepts and transitions at read committed and, if rollback fails, keeps the original error and discards the connection",async()=>{
  const sent:string[]=[],released:unknown[]=[];
  const client={query:async(sql:string)=>{sent.push(sql.trim().split(/\s+/).slice(0,4).join(" "));
    if(sql.startsWith("insert into peragus_customer_purchase_intents") || sql.startsWith("select status,customer_id"))throw new Error("original failure");
    if(sql==="rollback")throw new Error("rollback failure");
    // The runtime kill switch is read on the same connection; on here so the insert runs.
    if(sql.includes("from peragus_runtime_controls"))return{rows:[{enabled:true}]};
    return{rows:[]};},
   release:(err?:unknown)=>{released.push(err);}};
  const fake={query:async()=>({rows:[]}),connect:async()=>client} as unknown as Pool;
  const broken=new PostgresCustomerPurchaseIntentRepository(fake,"test",wide);
  await expect(broken.record(randomUUID(),randomUUID(),randomUUID())).rejects.toThrow("original failure");
  await expect(broken.transitionOperation(randomUUID(),"failed","system","synthetic")).rejects.toThrow("original failure");
  expect(sent.filter(s=>s.startsWith("begin"))).toEqual(["begin isolation level read","begin isolation level read"]);
  expect(released).toHaveLength(2);for(const err of released)expect((err as Error).message).toBe("rollback failure");
 });
});
