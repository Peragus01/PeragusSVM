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
import {CustomerPurchaseIntentService} from "../src/purchases/customer-purchase-intents.js";
const db=new PGlite();let failInsert=false;
const pool={query:async(sql:string,params?:unknown[])=>{
 if(failInsert && sql.startsWith("insert into peragus_customer_purchase_intents")){failInsert=false;throw new Error("private database details");}
 const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};
}} as unknown as Pool;
const customers=new PostgresCustomerRepository(pool),repo=new PostgresCustomerPurchaseIntentRepository(pool),service=new CustomerPurchaseIntentService(repo);
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),"utf8"));
},30000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
async function setup(type:"pf"|"pj"="pf"){
 const owner=randomUUID(),customer=(await customers.createOrGet({ownerUserId:owner,type,displayName:"Synthetic name"})).customer;
 const id=customer.id,provider=`ozav_cus_${id.replaceAll("-","")}`,terms=randomUUID(),wallet=Keypair.generate().publicKey.toBase58();
 await db.query(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,terms_version,expires_at,accepted_at,encrypted_token,encrypted_acceptance)
 values($1,$2,$3,now(),'accepted','https://ozav.io/terms','2.0',now()-interval '1 day',now()-interval '2 days','{}','{}')`,[terms,id,randomUUID()]);
 await db.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode,provider_snapshot,snapshot_version)
 values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full',$7,2)`,[randomUUID(),id,terms,"a".repeat(64),randomUUID(),provider,{requirements_pending:false}]);
 await db.query("insert into peragus_customer_wallets(customer_id,wallet_address,proof_challenge_id,verified_at,proof_message,proof_signature) values($1,$2,$3,now(),'private proof message','private proof signature')",[id,wallet,randomUUID()]);
 await db.query("insert into peragus_customer_verifications(customer_id,provider_customer_id,verification_id,observation,revision,refreshed_at) values($1,$2,$3,$4,3,now())",[id,provider,`ozav_vrf_${id.replaceAll("-","")}`,{status:"completed",checks:{kyc_document:"pass",liveness:"pass",face_match:"pass",aml_name_screening:"not_started"}}]);
 await db.query("insert into peragus_customer_screenings(customer_id,provider_customer_id,idempotency_key,screening_id,observation,revision,refreshed_at) values($1,$2,$3,$4,$5,4,now())",[id,provider,randomUUID(),`ozav_scr_${id.replaceAll("-","")}`,{status:"completed",result:"clear",matchesCount:0,suggestedDecision:"clear",lists:["sanctions","pep"]}]);
 const makeQuote=async()=>{
  const localId=randomUUID(),providerId=`ozav_q_${localId.replaceAll("-","")}`,observation={id:providerId,customerId:provider,rateType:"floating",rate:"0.2",source:{currency:"BRL",amount:"500.00"},target:{currency:"USDT",amount:"100.000000"},spreadBps:0,rateWithoutSpread:"0.2",amountDeducted:null,expiresAt:null,createdAt:new Date().toISOString(),private_data:"never return"};
  await db.query("insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,create_attempted,provider_quote_id,observation) values($1,$2,$3,$4,'500.00',true,$5,$6)",[localId,id,randomUUID(),provider,providerId,observation]);return localId;
 };
 const actualQuoteId=await makeQuote();
 return{owner,customer,provider,terms,wallet,quoteId:actualQuoteId,makeQuote,requestId:randomUUID()};
}
async function appFor(s:Awaited<ReturnType<typeof setup>>,enabled=true){
 const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return{id:s.owner,email:"private@example.test"};}},...(enabled?{customerPurchaseIntentService:service}:{})});apps.push(app);return app;
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
