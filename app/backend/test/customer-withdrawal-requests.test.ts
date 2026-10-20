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
 let posts=0,gets=0,simulations=0,listed:string|null=null;let mode="normal";
 const transfer:OzavTransfer={id:`ozav_tr_${randomUUID().replaceAll('-','')}`,status:"awaiting_payment",customerId:s.provider,
  quoteId:(await pixRepo.context(s.customer.id,p.data.id))!.providerQuoteId,
  source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"sandbox-code",qrCodeImage:null,expiresAt:new Date(Date.now()+60000).toISOString()}},
  destination:{type:"wallet",walletId:"ozav_wal_testmanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
  amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}};
 const provider={getCustomerCapabilities:async()=>({environment:"test",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
  getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
  getCustomerManagedWallet:async()=>"ozav_wal_testmanaged",
  createCustomerPixTransfer:async(input:any)=>{posts++;expect(input.metadata.peragus_pix_id).toBe(input.idempotencyKey.slice("peragus-pix-".length));if(mode==="timeout")throw new Error("private timeout");return{id:transfer.id,transfer:mode==="degraded"?null:transfer};},
  simulateCustomerPixPayment:async()=>{
   simulations++;
   if(mode!=="simulation-pending"){
    transfer.status="completed";transfer.sourceLegStatus="completed";transfer.destinationLegStatus="completed";
   }
   if(mode==="simulation-timeout")throw new Error("simulation response lost");
  },
  findCustomerPixTransfer:async()=>listed,
  getTransfer:async()=>{gets++;return transfer;}} as any;
 const pix=new CustomerSandboxPixService(pixRepo,provider),requestId=randomUUID();
 return{s,p,pix,pixRepo,provider,transfer,requestId,stats:()=>({posts,gets}),simulationCount:()=>simulations,setMode:(v:string)=>{mode=v;},setListed:(v:string|null)=>{listed=v;}};
}

import {PostgresCustomerWithdrawalRequestRepository} from "../src/repositories/postgres-customer-withdrawal-requests.js";
import {CustomerWithdrawalRequestService} from "../src/withdrawals/customer-withdrawal-requests.js";
const withdrawalRepo=new PostgresCustomerWithdrawalRequestRepository(pool),withdrawals=new CustomerWithdrawalRequestService(withdrawalRepo);
async function completedFixture(){
 const f=await fixture(),charge=await f.pix.create(f.s.customer.id,f.requestId,f.p.data.id);
 await f.pix.simulatePayment(f.s.customer.id,charge.data.id);
 return{...f,pixId:charge.data.id,withdrawalRequestId:randomUUID()};
}
async function withdrawalApp(f:Awaited<ReturnType<typeof completedFixture>>,enabled=true){
 const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return{id:f.s.owner};}},...(enabled?{customerWithdrawalRequestService:withdrawals}:{})});apps.push(app);return app;
}
const withdrawalPath="/v1/me/withdrawal-requests";
describe("record-only customer withdrawal requests",()=>{
 it("derives the actual converted amount, freezes the destination and does not call providers or queues",async()=>{
  const f=await completedFixture(),before=f.stats(),calls=f.simulationCount();
  const result=await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId);
  expect(result.replayed).toBe(false);expect(result.data).toMatchObject({pix_id:f.pixId,purchase_intent_id:f.p.data.id,source:{currency:"USDT",amount:"200.000000",basis:"recorded_completed_conversion"},destination:{wallet_address:f.s.wallet,proof_network:"solana:devnet"},record_only:true,state:"recorded",manual_approval_required:true,approved:false,withdrawal_started:false,balance_reserved:false,delivery_costs_evaluated:false,net_delivery_amount:null,provider_freshness_evaluated:false,job_enqueued:false,operations_enabled:false});
  expect(result.data.source.amount).not.toBe(f.p.data.estimated_target.amount);
  expect(f.stats()).toEqual(before);expect(f.simulationCount()).toBe(calls);
  const row=(await db.query("select evidence_snapshot from peragus_customer_withdrawal_requests where id=$1",[result.data.id])).rows[0] as any;
  expect(row.evidence_snapshot).toMatchObject({transfer_status:"completed",source_leg_status:"completed",destination_leg_status:"completed",verification_revision:3,screening_revision:4});
  expect((await db.query("select count(*) as n from settlements")).rows[0]).toEqual({n:0});
 });
 it("replays exactly, rejects request changes and prevents duplicate requests for a converted operation",async()=>{
  const f=await completedFixture(),one=await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId);
  const again=await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId);expect(again.replayed).toBe(true);expect(again.data).toEqual(one.data);
  expect(await withdrawals.read(f.s.customer.id,one.data.id)).toEqual(one.data);
  await expect(withdrawals.record(f.s.customer.id,f.withdrawalRequestId,randomUUID())).rejects.toThrow("WITHDRAWAL_IDEMPOTENCY_CONFLICT");
  await expect(withdrawals.record(f.s.customer.id,randomUUID(),f.pixId)).rejects.toThrow("WITHDRAWAL_ALREADY_RECORDED");
 });
 it("prevents duplicate records under concurrent request IDs",async()=>{
  const f=await completedFixture(),results=await Promise.allSettled([withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId),withdrawals.record(f.s.customer.id,randomUUID(),f.pixId)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect((await db.query("select count(*) as n from peragus_customer_withdrawal_requests where pix_id=$1",[f.pixId])).rows[0]).toEqual({n:1});
 });
 it("isolates foreign Pix records and withdrawal reads",async()=>{
  const f=await completedFixture(),other=await completedFixture(),one=await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId);
  await expect(withdrawals.record(other.s.customer.id,randomUUID(),f.pixId)).rejects.toThrow("WITHDRAWAL_PIX_NOT_FOUND");
  await expect(withdrawals.read(other.s.customer.id,one.data.id)).rejects.toThrow("WITHDRAWAL_REQUEST_NOT_FOUND");
  const app=await withdrawalApp(other);expect((await app.inject({method:"GET",url:`${withdrawalPath}/${one.data.id}`,headers})).statusCode).toBe(404);
 });
 it("blocks unpaid, uncertain, partially completed and expired conversions",async()=>{
  for(const change of [{status:"awaiting_payment"},{status:"expired"},{status:"payment_confirmed"},{sourceLegStatus:"pending"},{destinationLegStatus:"pending"}]){
   const f=await completedFixture();await db.query("update peragus_customer_sandbox_pix set observation=observation||$2::jsonb where id=$1",[f.pixId,JSON.stringify(change)]);
   await expect(withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId)).rejects.toThrow("WITHDRAWAL_PREREQUISITES_NOT_RECORDED");
  }
 });
 it("requires matching provider ownership, transfer, quote, amount, currency and managed wallet",async()=>{
  for(const [path,value] of [[['customerId'],'ozav_cus_foreign'],[['id'],'ozav_tr_foreign'],[['quoteId'],'ozav_q_foreign'],[['amounts','target','currency'],'USDC'],[['amounts','target','amount'],'0'],[['amounts','target','amount'],'not-a-number'],[['amounts','source','amount'],'99.00'],[['destination','walletId'],'ozav_wal_foreign']]){
   const f=await completedFixture();await db.query("update peragus_customer_sandbox_pix set observation=jsonb_set(observation,$2::text[],$3::jsonb) where id=$1",[f.pixId,path,JSON.stringify(value)]);
   await expect(withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId)).rejects.toThrow("WITHDRAWAL_PREREQUISITES_NOT_RECORDED");
  }
 });
 it("rechecks identity, screening, accepted terms, suspension and wallet proof",async()=>{
  for(const sql of ["update peragus_customers set suspended=true where id=$1","update peragus_customer_verifications set observation='{}' where customer_id=$1","update peragus_customer_screenings set observation='{}' where customer_id=$1","update peragus_customer_terms_sessions set state='uncertain' where customer_id=$1","delete from peragus_customer_wallets where customer_id=$1"]){
   const f=await completedFixture();await db.query(sql,[f.s.customer.id]);await expect(withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId)).rejects.toThrow("WITHDRAWAL_PREREQUISITES_NOT_RECORDED");
  }
 });
 it("preserves historical amount and destination on replay after later observations change",async()=>{
  const f=await completedFixture(),one=await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId);
  await db.query("update peragus_customer_sandbox_pix set observation=jsonb_set(observation,'{amounts,target,amount}','\"999.00\"') where id=$1",[f.pixId]);
  await db.query("update peragus_customer_wallets set wallet_address=$2 where customer_id=$1",[f.s.customer.id,Keypair.generate().publicKey.toBase58()]);
  expect((await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId)).data).toEqual(one.data);
 });
 it("enforces API auth, feature gates, strict input, no-store and safe response fields",async()=>{
  const f=await completedFixture(),app=await withdrawalApp(f),payload={request_id:f.withdrawalRequestId,pix_id:f.pixId};
  expect((await app.inject({method:"POST",url:withdrawalPath,payload})).statusCode).toBe(401);
  expect((await(await withdrawalApp(f,false)).inject({method:"POST",url:withdrawalPath,headers,payload})).statusCode).toBe(503);
  for(const extra of [{amount:"1"},{wallet_address:"arbitrary"},{approved:true},{provider_customer_id:f.s.provider}])expect((await app.inject({method:"POST",url:withdrawalPath,headers,payload:{...payload,...extra}})).statusCode).toBe(400);
  const r=await app.inject({method:"POST",url:withdrawalPath,headers,payload});expect(r.statusCode).toBe(201);expect(r.headers["cache-control"]).toBe("no-store");expect(r.headers.location).toBe(`${withdrawalPath}/${r.json().data.id}`);
  for(const hidden of [f.s.provider,f.transfer.id,"private proof","ozav_wal_","sandbox-code"])expect(r.body).not.toContain(hidden);
  const repeat=await app.inject({method:"POST",url:withdrawalPath,headers,payload});expect(repeat.statusCode).toBe(200);expect(repeat.json().meta.idempotent_replay).toBe(true);
 });
 it("enforces sandbox record-only and ownership database constraints and browser revocations",async()=>{
  const f=await completedFixture(),other=await completedFixture(),one=await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId);
  for(const assignment of ["environment='live'","record_only=false","state='approved'","amount_usdt=0","proof_network='solana:mainnet'",`customer_id='${other.s.customer.id}'`])await expect(db.query(`update peragus_customer_withdrawal_requests set ${assignment} where id=$1`,[one.data.id])).rejects.toThrow();
  const r=await db.query("select relrowsecurity,has_table_privilege('anon','peragus_customer_withdrawal_requests','SELECT') as anon_select,has_table_privilege('authenticated','peragus_customer_withdrawal_requests','INSERT') as auth_insert from pg_class where relname='peragus_customer_withdrawal_requests'");expect(r.rows[0]).toEqual({relrowsecurity:true,anon_select:false,auth_insert:false});
 });
});
