// Live money mode on a PGlite database recorded as 'live' (solana:mainnet rows).
// No real OZAV: the provider is a fake; live keys never leave this file.
import {randomUUID} from "node:crypto";
import {Keypair} from "@solana/web3.js";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,afterAll,afterEach,describe,it,expect,vi} from "vitest";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresCustomerPurchaseIntentRepository} from "../src/repositories/postgres-customer-purchase-intents.js";
import {PostgresCustomerQuoteRepository} from "../src/repositories/postgres-customer-quotes.js";
import {PostgresCustomerPixRepository} from "../src/repositories/postgres-customer-sandbox-pix.js";
import {CustomerPixService} from "../src/purchases/customer-sandbox-pix.js";
import {OzavFacilityLockRefusedError,type OzavFacilityOutcome,type OzavIndicativeQuote,type OzavTransfer} from "../src/providers/ozav-client.js";

const db=new PGlite();let connection=Promise.resolve();
const query=async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};};
const pool={query,connect:async()=>{
 const previous=connection;let release!:()=>void;connection=new Promise<void>(resolve=>{release=resolve;});await previous;
 return{query,release};
}} as unknown as Pool;
const wide={maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}};
const customers=new PostgresCustomerRepository(pool),purchases=new PostgresCustomerPurchaseIntentRepository(pool,"live",wide);
beforeAll(async()=>{
 await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),"utf8"));
 await db.exec("insert into peragus_database_environment(environment) values('live')");
},30000);
afterAll(async()=>{await db.close();});
afterEach(()=>{vi.useRealTimers();});

async function setup(terms:string|null="2.0"){
 const owner=randomUUID(),customer=(await customers.createOrGet({ownerUserId:owner,type:"pf",displayName:"Synthetic name"})).customer;
 const id=customer.id,provider=`ozav_cus_${id.replaceAll("-","")}`,session=randomUUID(),wallet=Keypair.generate().publicKey.toBase58();
 await db.query(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,terms_version,expires_at,accepted_at,encrypted_token,encrypted_acceptance,environment)
 values($1,$2,$3,now(),'accepted','https://ozav.io/terms','2.0',now()-interval '1 day',now()-interval '2 days','{}','{}','live')`,[session,id,randomUUID()]);
 await db.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode,provider_snapshot,snapshot_version,environment)
 values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full',$7,2,'live')`,[randomUUID(),id,session,"a".repeat(64),randomUUID(),provider,{requirements_pending:false}]);
 await db.query("insert into peragus_customer_wallets(customer_id,wallet_address,proof_challenge_id,verified_at,proof_message,proof_signature,environment,network) values($1,$2,$3,now(),'private proof message','private proof signature','live','solana:mainnet')",[id,wallet,randomUUID()]);
 await db.query("insert into peragus_customer_verifications(customer_id,provider_customer_id,verification_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,3,now(),'live')",[id,provider,`ozav_vrf_${id.replaceAll("-","")}`,{status:"completed",checks:{kyc_document:"pass",liveness:"pass",face_match:"pass",aml_name_screening:"not_started"}}]);
 await db.query("insert into peragus_customer_screenings(customer_id,provider_customer_id,idempotency_key,screening_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,$5,4,now(),'live')",[id,provider,randomUUID(),`ozav_scr_${id.replaceAll("-","")}`,{status:"completed",result:"clear",matchesCount:0,suggestedDecision:"clear",lists:["sanctions","pep"]}]);
 const quoteId=randomUUID(),providerQuoteId=`ozav_q_${quoteId.replaceAll("-","")}`;
 const observation={id:providerQuoteId,customerId:provider,rateType:"floating",rate:"0.2",source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"},spreadBps:0,rateWithoutSpread:"0.2",amountDeducted:null,expiresAt:null,createdAt:new Date().toISOString()};
 await db.query(`insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,create_attempted,provider_quote_id,observation,environment,facility_terms_version,locked_usdt_amount)
  values($1,$2,$3,$4,'1000.00',true,$5,$6,'live',$7,$8)`,[quoteId,id,randomUUID(),provider,providerQuoteId,observation,terms,terms?"200.000000":null]);
 return{owner,customer,provider,wallet,quoteId,providerQuoteId};
}
const statusOf=async(purchaseId:string)=>(await db.query<{status:string}>("select status from peragus_customer_purchase_intents where id=$1",[purchaseId])).rows[0]!.status;
const eventsOf=async(purchaseId:string)=>(await db.query<{from_status:string|null;to_status:string;actor:string;reason:string;environment:string}>(
 "select from_status,to_status,actor,reason,environment from peragus_operation_status_events where purchase_id=$1 order by id",[purchaseId])).rows;

const LOCKED:OzavFacilityOutcome={locked:true,state:"locked",reason:null,amount:"200.000000",currency:"USDT",deadlineAt:"2099-01-01T00:00:00Z"};
async function fixture(){
 const s=await setup(),p=(await purchases.record(s.customer.id,randomUUID(),s.quoteId)).record,pixRepo=new PostgresCustomerPixRepository(pool,"live");
 let posts=0,capsCalls=0,listed:string|null=null,mode="locked",facility:OzavFacilityOutcome|null=LOCKED;const inputs:any[]=[];
 const transfer:OzavTransfer={id:`ozav_tr_${randomUUID().replaceAll("-","")}`,status:"awaiting_payment",customerId:s.provider,quoteId:s.providerQuoteId,
  source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"000201live-br-code",qrCodeImage:null,expiresAt:new Date(Date.now()+600000).toISOString()}},
  destination:{type:"wallet",walletId:"ozav_wal_livemanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
  amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}};
 const provider={getCustomerCapabilities:async()=>{capsCalls++;return{environment:"live",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]};},
  getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
  getCustomerManagedWallet:async()=>"ozav_wal_livemanaged",
  createCustomerPixTransfer:async(input:any)=>{posts++;inputs.push(input);
   if(mode==="timeout")throw new Error("private timeout");
   if(mode==="refused")throw new OzavFacilityLockRefusedError(422,"FACILITY_LOCK_UNAVAILABLE","client_not_exempt");
   return{id:transfer.id,transfer,facility};},
  simulateCustomerPixPayment:async()=>{throw new Error("never in live");},
  findCustomerPixTransfer:async()=>listed,
  getTransfer:async()=>transfer} as any;
 const pix=new CustomerPixService(pixRepo,provider,"live",purchases),requestId=randomUUID();
 return{s,p,pix,transfer,requestId,inputs,posts:()=>posts,capsCalls:()=>capsCalls,setMode:(v:string)=>{mode=v;},setFacility:(v:OzavFacilityOutcome|null)=>{facility=v;},setListed:(v:string|null)=>{listed=v;}};
}

describe("live accept-time gate (database recorded as live)",()=>{
 it("refuses a live quote with null facility_terms_version and saves nothing",async()=>{
  const s=await setup(null);
  await expect(purchases.record(s.customer.id,randomUUID(),s.quoteId)).rejects.toMatchObject({code:"PURCHASE_PREREQUISITES_NOT_RECORDED"});
  expect((await db.query("select count(*)::int n from peragus_customer_purchase_intents where customer_id=$1",[s.customer.id])).rows[0]).toEqual({n:0});
  expect((await db.query("select count(*)::int n from peragus_operation_status_events where customer_id=$1",[s.customer.id])).rows[0]).toEqual({n:0});
 });
 it("accepts a live quote with the lock and copies terms version and locked amount",async()=>{
  const s=await setup(),r=await purchases.record(s.customer.id,randomUUID(),s.quoteId);
  const row=(await db.query<any>("select facility_terms_version,locked_usdt_amount,environment,wallet_proof_network,status from peragus_customer_purchase_intents where id=$1",[r.record.id])).rows[0];
  expect(row).toEqual({facility_terms_version:"2.0",locked_usdt_amount:"200.000000",environment:"live",wallet_proof_network:"solana:mainnet",status:"accepted"});
 });
});

describe("quote repository defence in depth",()=>{
 it("refuses to save a live quote without a facility block",async()=>{
  const s=await setup(),quotes=new PostgresCustomerQuoteRepository(pool,"live");
  const row=await quotes.reserve(s.customer.id,randomUUID(),s.provider,"1000.00");expect(await quotes.claim(row.id)).toBe(true);
  const quote:OzavIndicativeQuote={id:`ozav_q_${randomUUID().replaceAll("-","")}`,customerId:s.provider,rateType:"floating",rate:"0.2",source:{currency:"BRL",amount:"1000.00"},
   target:{currency:"USDT",amount:"200.000000"},spreadBps:0,rateWithoutSpread:"0.2",amountDeducted:null,expiresAt:null,createdAt:new Date().toISOString()};
  await expect(quotes.save(row,quote)).rejects.toMatchObject({code:"QUOTE_RATE_LOCK_UNAVAILABLE"});
  const stored=(await db.query<any>("select provider_quote_id,observation,facility_terms_version,locked_usdt_amount from peragus_customer_indicative_quotes where id=$1",[row.id])).rows[0];
  expect(stored).toEqual({provider_quote_id:null,observation:null,facility_terms_version:null,locked_usdt_amount:null});
  const saved=await quotes.save(row,{...quote,facility:{termsVersion:"2.0"}});expect(saved).toMatchObject({facilityTermsVersion:"2.0",lockedUsdtAmount:"200.000000"});
 });
});

describe("live Pix with the FX rate lock",()=>{
 it("live transfer carries facility_terms_accepted and version and the Idempotency-Key peragus-pix-<uuid>",async()=>{
  const f=await fixture(),r=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);
  expect(f.posts()).toBe(1);
  expect(f.inputs[0]).toMatchObject({facilityTermsVersion:"2.0",quoteId:f.s.providerQuoteId,walletId:"ozav_wal_livemanaged",idempotencyKey:`peragus-pix-${r.data.id}`});
  expect(f.inputs[0].idempotencyKey).toMatch(/^peragus-pix-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(r.data).toMatchObject({status:"awaiting_pix",state:"awaiting_payment",environment:"live",real_money:true,
   payment_instructions:{br_code:"000201live-br-code",expires_at:f.transfer.source.paymentInstructions!.expiresAt},subsequent_delivery:{proof_network:"solana:mainnet",started:false}});
  expect(await statusOf(f.p.id)).toBe("awaiting_pix");
  expect((await eventsOf(f.p.id)).at(-1)).toEqual({from_status:"accepted",to_status:"awaiting_pix",actor:"system:pix",
   reason:"rate_locked: facility.amount=200.000000 USDT deadline_at=2099-01-01T00:00:00.000Z",environment:"live"});
  const again=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);expect(again.replayed).toBe(true);expect(again.data.payment_instructions?.br_code).toBe("000201live-br-code");expect(f.posts()).toBe(1);
  expect((await f.pix.read(f.s.customer.id,r.data.id)).payment_instructions).not.toBeNull();
 });
 it("rate lock refusal marks the operation failed and returns no payment instructions",async()=>{
  const f=await fixture();f.setMode("refused");
  await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.id)).rejects.toMatchObject({code:"PIX_RATE_LOCK_UNAVAILABLE"});
  expect(await statusOf(f.p.id)).toBe("failed");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({from_status:"accepted",to_status:"failed",actor:"system:pix",reason:"RATE_LOCK_REFUSED: FACILITY_LOCK_UNAVAILABLE reason=client_not_exempt"});
  const replay=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);
  expect(replay.replayed).toBe(true);expect(replay.data).toMatchObject({status:"failed",state:"failed",payment_instructions:null,recovery_required:false});
  await expect(f.pix.create(f.s.customer.id,randomUUID(),f.p.id)).rejects.toThrow();
  expect(f.posts()).toBe(1);
 });
 it("a lock that did not happen, is undetermined or missing fails the operation without instructions",async()=>{
  for(const facility of [{locked:false,state:"not_locked",reason:null,amount:null,currency:null,deadlineAt:null},
   {locked:false,state:"refused",reason:"collateral_insufficient",amount:null,currency:null,deadlineAt:null},
   {locked:false,state:"undetermined",reason:null,amount:null,currency:null,deadlineAt:null},null] as (OzavFacilityOutcome|null)[]){
   const f=await fixture();f.setFacility(facility);
   await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.id)).rejects.toMatchObject({code:"PIX_RATE_LOCK_UNAVAILABLE"});
   expect(await statusOf(f.p.id)).toBe("failed");
   expect((await eventsOf(f.p.id)).at(-1)!.reason).toMatch(/^RATE_LOCK_NOT_APPLIED: state=/);
   const replay=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);expect(replay.data.payment_instructions).toBeNull();expect(f.posts()).toBe(1);
  }
 });
 it("fails closed with LOCKED_AMOUNT_MISMATCH when facility.amount is below locked_usdt_amount or not USDT",async()=>{
  for(const facility of [{...LOCKED,amount:"199.999999"},{...LOCKED,amount:"0"},{...LOCKED,currency:"USDC"}]){
   const f=await fixture();f.setFacility(facility);
   await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.id)).rejects.toMatchObject({code:"PIX_LOCKED_AMOUNT_MISMATCH"});
   expect(await statusOf(f.p.id)).toBe("failed");
   const event=(await eventsOf(f.p.id)).at(-1)!;
   expect(event.reason).toBe(`LOCKED_AMOUNT_MISMATCH: facility.amount=${facility.amount} ${facility.currency} locked_usdt_amount=200.000000`);
   const replay=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);expect(replay.data.payment_instructions).toBeNull();
   const list=(await db.query<any>("select id from peragus_customer_sandbox_pix where purchase_intent_id=$1",[f.p.id])).rows;
   expect((await f.pix.reconcile(f.s.customer.id,list[0].id)).payment_instructions).toBeNull();expect(f.posts()).toBe(1);
  }
  // Ruling 18: equal or higher than the locked amount is accepted.
  for(const amount of ["200","200.000000","200.000001","250.5"]){
   const ok=await fixture();ok.setFacility({...LOCKED,amount});
   expect((await ok.pix.create(ok.s.customer.id,ok.requestId,ok.p.id)).data.status).toBe("awaiting_pix");
  }
 });
 it("ambiguous create keeps the claim and never re-posts; GET recovery never exposes live instructions",async()=>{
  const f=await fixture();f.setMode("timeout");
  await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.id)).rejects.toThrow("private timeout");
  const replay=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);
  expect(replay.data).toMatchObject({state:"uncertain",status:"accepted",recovery_required:true,payment_instructions:null});
  await expect(f.pix.create(f.s.customer.id,randomUUID(),f.p.id)).rejects.toThrow();
  f.setListed(f.transfer.id);const recovered=await f.pix.reconcile(f.s.customer.id,replay.data.id);
  expect(recovered).toMatchObject({state:"awaiting_payment",status:"accepted",payment_instructions:null});
  expect(f.posts()).toBe(1);expect(await statusOf(f.p.id)).toBe("accepted");
 });
 it("refuses live simulation, and a live Pix without the purchase repository to record the lock, before any POST",async()=>{
  const f=await fixture();
  const pix=new CustomerPixService(new PostgresCustomerPixRepository(pool,"live"),{} as any,"live");
  await expect(pix.simulatePayment(f.s.customer.id,randomUUID())).rejects.toMatchObject({code:"PIX_SIMULATION_NOT_AVAILABLE"});
  // Without the purchase repository there is nothing to record the lock outcome with.
  const caps={getCustomerCapabilities:async()=>({environment:"live",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
   getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
   getCustomerManagedWallet:async()=>"ozav_wal_livemanaged",createCustomerPixTransfer:async()=>{throw new Error("must not POST");}} as any;
  await expect(new CustomerPixService(new PostgresCustomerPixRepository(pool,"live"),caps,"live").create(f.s.customer.id,randomUUID(),f.p.id))
   .rejects.toMatchObject({code:"PIX_RATE_LOCK_REQUIRED"});
  expect(f.posts()).toBe(0);
 });
 it("a new request_id on a purchase already awaiting the Pix fails before any provider call",async()=>{
  const f=await fixture();await f.pix.create(f.s.customer.id,f.requestId,f.p.id);const calls=f.capsCalls();
  await expect(f.pix.create(f.s.customer.id,randomUUID(),f.p.id)).rejects.toMatchObject({code:"PIX_PURCHASE_NOT_ELIGIBLE"});
  expect(f.capsCalls()).toBe(calls);expect(f.posts()).toBe(1);
 });
 it("stores the lock deadline and hides instructions once a deadline earlier than the Pix expiry passes",async()=>{
  const f=await fixture(),deadline=new Date(Date.now()+60000).toISOString();f.setFacility({...LOCKED,deadlineAt:deadline});
  const r=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);
  // The validity the customer sees is the earlier of the Pix expiry and the lock deadline.
  expect(r.data.payment_instructions).toMatchObject({br_code:"000201live-br-code",expires_at:deadline});
  const stored=(await db.query<any>("select lock_deadline_at from peragus_customer_sandbox_pix where id=$1",[r.data.id])).rows[0];
  expect(new Date(stored.lock_deadline_at).toISOString()).toBe(deadline);
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.parse(deadline)+1);
  expect((await f.pix.read(f.s.customer.id,r.data.id)).payment_instructions).toBeNull();
  vi.setSystemTime(Date.parse(deadline)-1000);
  expect((await f.pix.read(f.s.customer.id,r.data.id)).payment_instructions?.expires_at).toBe(deadline);
 });
 it("shows the Pix expiry when it is earlier than the lock deadline",async()=>{
  const f=await fixture(),r=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);
  expect(r.data.payment_instructions?.expires_at).toBe(f.transfer.source.paymentInstructions!.expiresAt);
 });
 it("fails closed with LOCK_DEADLINE_INVALID when the deadline is missing, unparseable or already past",async()=>{
  for(const deadlineAt of [null,"not-a-date","2026-13-45T00:00:00Z","2099-01-01",new Date(Date.now()-1000).toISOString()]){
   const f=await fixture();f.setFacility({...LOCKED,deadlineAt});
   await expect(f.pix.create(f.s.customer.id,f.requestId,f.p.id)).rejects.toMatchObject({code:"PIX_RATE_LOCK_UNAVAILABLE"});
   expect(await statusOf(f.p.id)).toBe("failed");
   expect((await eventsOf(f.p.id)).at(-1)!.reason).toMatch(/^LOCK_DEADLINE_INVALID/);
   const replay=await f.pix.create(f.s.customer.id,f.requestId,f.p.id);expect(replay.data.payment_instructions).toBeNull();expect(f.posts()).toBe(1);
  }
 });
});
