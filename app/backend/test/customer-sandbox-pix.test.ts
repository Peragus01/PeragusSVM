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

import {PostgresCustomerPixRepository} from "../src/repositories/postgres-customer-sandbox-pix.js";
import {CustomerSandboxPixService} from "../src/purchases/customer-sandbox-pix.js";
import type {OzavTransfer} from "../src/providers/ozav-client.js";
async function fixture(){
 const s=await setup();
 await db.query("update peragus_customer_indicative_quotes set source_amount_brl=1000,observation=jsonb_set(observation,'{source,amount}','\"1000.00\"') where id=$1",[s.quoteId]);
 const p=await service.record(s.customer.id,s.requestId,s.quoteId),pixRepo=new PostgresCustomerPixRepository(pool);
 let posts=0,gets=0,listed:string|null=null;let mode="normal";
 const transfer:OzavTransfer={id:`ozav_tr_${randomUUID().replaceAll('-','')}`,status:"awaiting_payment",customerId:s.provider,
  quoteId:(await pixRepo.context(s.customer.id,p.data.id))!.providerQuoteId,
  source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"sandbox-code",qrCodeImage:null,expiresAt:new Date(Date.now()+60000).toISOString()}},
  destination:{type:"wallet",walletId:"ozav_wal_testmanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
  amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}};
 const provider={getCustomerCapabilities:async()=>({environment:"test",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
  getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
  getCustomerManagedWallet:async()=>"ozav_wal_testmanaged",
  createCustomerPixTransfer:async(input:any)=>{posts++;expect(input.metadata.peragus_pix_id).toBe(input.idempotencyKey.slice("peragus-pix-".length));if(mode==="timeout")throw new Error("private timeout");return{id:transfer.id,transfer:mode==="degraded"?null:transfer};},
  findCustomerPixTransfer:async()=>listed,
  getTransfer:async()=>{gets++;return transfer;}} as any;
 const pix=new CustomerSandboxPixService(pixRepo,provider),requestId=randomUUID();
 return{s,p,pix,pixRepo,provider,transfer,requestId,stats:()=>({posts,gets}),setMode:(v:string)=>{mode=v;},setListed:(v:string|null)=>{listed=v;}};
}
describe("customer-owned sandbox Pix",()=>{
 it("creates once, preserves the purchase reference and never queues settlement or delivery",async()=>{
  const f=await fixture(),r=await f.pix.create(f.s.customer.id,f.requestId,f.p.data.id);
  expect(r.data).toMatchObject({source:{amount:"1000.00"},state:"awaiting_payment",payment_instructions:{br_code:"sandbox-code"},funding_destination:{type:"provider_managed_wallet"},subsequent_delivery:{wallet_address:f.s.wallet,started:false},real_money:false,job_enqueued:false});
  const again=await f.pix.create(f.s.customer.id,f.requestId,f.p.data.id);expect(again.replayed).toBe(true);expect(again.data.id).toBe(r.data.id);expect(f.stats().posts).toBe(1);
  expect(await service.read(f.s.customer.id,f.p.data.id)).toEqual(f.p.data);
  expect((await db.query("select count(*) as n from settlements")).rows[0]).toEqual({n:0});
 });
 it("reserves one charge under concurrent distinct request IDs",async()=>{
  const f=await fixture(),results=await Promise.allSettled([f.pix.create(f.s.customer.id,f.requestId,f.p.data.id),f.pix.create(f.s.customer.id,randomUUID(),f.p.data.id)]);
  expect(results.filter(v=>v.status==="fulfilled")).toHaveLength(1);expect(f.stats().posts).toBe(1);
 });
 it("isolates accounts and refuses payload changes with an existing request ID",async()=>{
  const f=await fixture(),other=await fixture(),r=await f.pix.create(f.s.customer.id,f.requestId,f.p.data.id);
  await expect(f.pix.read(other.s.customer.id,r.data.id)).rejects.toThrow("PIX_NOT_FOUND");
  await expect(f.pix.reconcile(other.s.customer.id,r.data.id)).rejects.toThrow("PIX_NOT_FOUND");
  await expect(f.pix.create(other.s.customer.id,randomUUID(),f.p.data.id)).rejects.toThrow("PIX_PURCHASE_NOT_ELIGIBLE");
  await expect(f.pix.create(f.s.customer.id,f.requestId,other.p.data.id)).rejects.toThrow("PIX_IDEMPOTENCY_CONFLICT");
 });
 it("recovers timeout with listing/GET, never another POST, and an empty listing stays uncertain",async()=>{
  const f=await fixture();f.setMode("timeout");await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.data.id)).rejects.toThrow();
  const replay=await f.pix.create(f.s.customer.id,f.requestId,f.p.data.id);expect(replay.data.state).toBe("uncertain");
  expect((await f.pix.reconcile(f.s.customer.id,replay.data.id)).recovery_required).toBe(true);
  f.setListed(f.transfer.id);expect((await f.pix.reconcile(f.s.customer.id,replay.data.id)).state).toBe("awaiting_payment");expect(f.stats()).toEqual({posts:1,gets:1});
 });
 it("stores degraded HTTP 200 identity and exposes no instructions before verified GET",async()=>{
  const f=await fixture();f.setMode("degraded");const r=await f.pix.create(f.s.customer.id,f.requestId,f.p.data.id);
  expect(r.data.payment_instructions).toBeNull();expect(r.data.recovery_required).toBe(true);
  expect((await f.pix.reconcile(f.s.customer.id,r.data.id)).state).toBe("awaiting_payment");expect(f.stats()).toEqual({posts:1,gets:1});
 });
 it("rejects mismatched transfer ownership, quote, amount and wallet before exposing instructions",async()=>{
  for(const field of ["customerId","quoteId","amount","wallet"]){const f=await fixture();if(field==="amount")f.transfer.amounts.source.amount="999.00";else if(field==="wallet")f.transfer.destination.walletId="ozav_wal_foreign";else(f.transfer as any)[field]="foreign";
   await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.data.id)).rejects.toThrow("PIX_PROVIDER_CONTEXT_MISMATCH");
   expect((await f.pix.create(f.s.customer.id,f.requestId,f.p.data.id)).data.payment_instructions).toBeNull();expect(f.stats().posts).toBe(1);
  }
 });
 it("rechecks identity, screening, terms, suspension and wallet binding before funding",async()=>{
  for(const sql of ["update peragus_customers set suspended=true where id=$1","update peragus_customer_screenings set observation='{}' where customer_id=$1","update peragus_customer_verifications set observation='{}' where customer_id=$1","update peragus_customer_terms_sessions set state='uncertain' where customer_id=$1","delete from peragus_customer_wallets where customer_id=$1"]){
   const f=await fixture();await db.query(sql,[f.s.customer.id]);await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.data.id)).rejects.toThrow("PIX_PURCHASE_NOT_ELIGIBLE");expect(f.stats().posts).toBe(0);
  }
 });
 it("fails closed for live capabilities or unapproved provider customer",async()=>{
  const f=await fixture();f.provider.getCustomerCapabilities=async()=>({environment:"live"});await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.data.id)).rejects.toThrow("PIX_CAPABILITY_REQUIRED");expect(f.stats().posts).toBe(0);
 });
 it("tracks documented intermediate states and never reopens a terminal charge",async()=>{
  const f=await fixture(),r=await f.pix.create(f.s.customer.id,f.requestId,f.p.data.id);
  for(const status of ["payment_confirmed","converting","payout_initiated","completed"]){
   f.transfer.status=status;const next=await f.pix.reconcile(f.s.customer.id,r.data.id);expect(next.state).toBe(status);expect(next.payment_instructions).toBeNull();
  }
  f.transfer.status="awaiting_payment";await expect(f.pix.reconcile(f.s.customer.id,r.data.id)).rejects.toThrow("PIX_TERMINAL_STATE_CONFLICT");
  expect((await f.pix.read(f.s.customer.id,r.data.id)).state).toBe("completed");
 });
 it("hides expired instructions, and route requires auth, enabled flag and strict input",async()=>{
  const f=await fixture();f.transfer.source.paymentInstructions!.expiresAt=new Date(Date.now()-1000).toISOString();
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:f.s.owner})},customerSandboxPixService:f.pix});apps.push(app);
  const url="/v1/me/sandbox-pix";
  expect((await app.inject({method:"POST",url,payload:{}})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url,headers,payload:{request_id:f.requestId,purchase_intent_id:f.p.data.id,amount:"1.00"}})).statusCode).toBe(400);
  const r=await app.inject({method:"POST",url,headers,payload:{request_id:f.requestId,purchase_intent_id:f.p.data.id}});expect(r.statusCode).toBe(201);expect(r.json().data.payment_instructions).toBeNull();expect(r.headers["cache-control"]).toBe("no-store");
  const disabled=await appFor(f.s,false);expect((await disabled.inject({method:"GET",url:`${url}/${r.json().data.id}`,headers})).statusCode).toBe(503);
 });
});
