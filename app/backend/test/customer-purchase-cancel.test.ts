import { enableRuntimeControls } from "./helpers/runtime-controls.js";
// Customer cancel before Pix payment (refund policy 7.1) on a PGlite database
// recorded as 'live'. No real OZAV: the provider is a fake (GET only for cancel).
import { allAcceptedLegal } from "./helpers/legal-double.js";
import {randomUUID} from "node:crypto";
import {Keypair} from "@solana/web3.js";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,afterAll,afterEach,describe,it,expect,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresCustomerPurchaseIntentRepository} from "../src/repositories/postgres-customer-purchase-intents.js";
import {PostgresCustomerPixRepository} from "../src/repositories/postgres-customer-sandbox-pix.js";
import {PostgresCustomerWithdrawalRequestRepository} from "../src/repositories/postgres-customer-withdrawal-requests.js";
import {PostgresPurchaseCancelRepository} from "../src/repositories/postgres-customer-purchase-cancel.js";
import {CustomerPixService} from "../src/purchases/customer-sandbox-pix.js";
import {CustomerPurchaseCancelService} from "../src/purchases/customer-purchase-cancel.js";
import {PurchaseProgression} from "../src/purchases/purchase-progression.js";
import {ManualRefundService} from "../src/refunds/manual-refunds.js";
import type {OzavFacilityOutcome,OzavTransfer} from "../src/providers/ozav-client.js";

const db=new PGlite();let connection=Promise.resolve();
const query=async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};};
const pool={query,connect:async()=>{
 const previous=connection;let release!:()=>void;connection=new Promise<void>(resolve=>{release=resolve;});await previous;
 return{query,release};
}} as unknown as Pool;
const wide={maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}};
const customers=new PostgresCustomerRepository(pool),purchases=new PostgresCustomerPurchaseIntentRepository(pool,"live",wide);
const refunds=new ManualRefundService(pool,new Set<string>(),true,"live",true);
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),"utf8"));
 await db.exec("insert into peragus_database_environment(environment) values('live')");
 // Runtime kill switches start OFF (054); this suite performs guarded actions.
 await enableRuntimeControls(db);
},30000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
afterEach(()=>{vi.useRealTimers();});

async function setup(){
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
  values($1,$2,$3,$4,'1000.00',true,$5,$6,'live','2.0','200.000000')`,[quoteId,id,randomUUID(),provider,providerQuoteId,observation]);
 return{owner,customer,provider,wallet,quoteId,providerQuoteId};
}
const statusOf=async(purchaseId:string)=>(await db.query<{status:string}>("select status from peragus_customer_purchase_intents where id=$1",[purchaseId])).rows[0]!.status;
const eventsOf=async(purchaseId:string)=>(await db.query<{from_status:string|null;to_status:string;actor:string;reason:string}>(
 "select from_status,to_status,actor,reason from peragus_operation_status_events where purchase_id=$1 order by id",[purchaseId])).rows;
const LOCKED:OzavFacilityOutcome={locked:true,state:"locked",reason:null,amount:"200.000000",currency:"USDT",deadlineAt:"2099-01-01T00:00:00Z"};

async function fixture(options:{pix?:boolean;facility?:OzavFacilityOutcome;gate?:Promise<void>}={}){
 const s=await setup(),p=(await purchases.record(s.customer.id,randomUUID(),s.quoteId)).record,pixRepo=new PostgresCustomerPixRepository(pool,"live");
 let posts=0,listed:string|null=null,getError:Error|null=null;const gets:string[]=[];
 const awaiting:OzavTransfer={id:`ozav_tr_${randomUUID().replaceAll("-","")}`,status:"awaiting_payment",customerId:s.provider,quoteId:s.providerQuoteId,
  source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"000201live-br-code",qrCodeImage:null,expiresAt:new Date(Date.now()+600000).toISOString()}},
  destination:{type:"wallet",walletId:"ozav_wal_livemanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
  amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}};
 let current:OzavTransfer=awaiting,gate=options.gate;
 const provider={getCustomerCapabilities:async()=>({environment:"live",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
  getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
  getCustomerManagedWallet:async()=>"ozav_wal_livemanaged",
  createCustomerPixTransfer:async()=>{posts++;if(gate)await gate;return{id:awaiting.id,transfer:awaiting,facility:options.facility??LOCKED};},
  simulateCustomerPixPayment:async()=>{throw new Error("never in live");},
  findCustomerPixTransfer:async()=>listed,
  getTransfer:async(id:string)=>{gets.push(id);if(getError)throw getError;return current;}} as any;
 const pix=new CustomerPixService(pixRepo,provider,"live",purchases);
 const progression=new PurchaseProgression({pool,mode:"live",operations:purchases,
  withdrawals:new PostgresCustomerWithdrawalRequestRepository(pool,"live"),refunds,pix:{repo:pixRepo,provider}});
 const cancels=new CustomerPurchaseCancelService(new PostgresPurchaseCancelRepository(pool,"live"),progression);
 let pixId:string|null=null;
 if(options.pix!==false)pixId=(await pix.create(s.customer.id,randomUUID(),p.id)).data.id;
 const set=(patch:Partial<OzavTransfer>)=>{current={...awaiting,...patch};};
 const paid=(status:string,extra:Partial<OzavTransfer>={})=>set({status,sourceLegStatus:"completed",source:{type:"fiat_payment",currency:"BRL",rail:"pix"},...extra});
 const refresh=()=>progression.refreshPix(s.customer.id,pixId!);
 const cancel=(requestId=randomUUID(),customerId=s.customer.id)=>cancels.cancel(customerId,p.id,requestId);
 return{s,p,pix,pixRepo,progression,cancels,provider,awaiting,set,paid,refresh,cancel,gets,posts:()=>posts,
  pixId:()=>pixId,setPixId:(v:string)=>{pixId=v;},setListed:(v:string|null)=>{listed=v;},setGetError:(e:Error|null)=>{getError=e;}};
}

describe("customer cancel before Pix payment (policy 7.1)",()=>{
 it("cancel in awaiting_pix with unpaid GET records cancel request, hides instructions, keeps status awaiting_pix",async()=>{
  const f=await fixture();expect(await statusOf(f.p.id)).toBe("awaiting_pix");
  expect((await f.pix.read(f.s.customer.id,f.pixId()!)).payment_instructions).not.toBeNull();
  const before=f.gets.length,r=await f.cancel();
  expect(f.gets.length).toBe(before+1);
  expect(r.replayed).toBe(false);
  expect(r.data).toEqual({purchase_id:f.p.id,status:"awaiting_pix",cancel_requested_at:expect.any(String)});
  expect(await statusOf(f.p.id)).toBe("awaiting_pix");
  expect((await eventsOf(f.p.id)).at(-1)).toEqual({from_status:"awaiting_pix",to_status:"awaiting_pix",actor:`customer:${f.s.customer.id}`,reason:"CUSTOMER_CANCEL_REQUESTED"});
  const view=await f.pix.read(f.s.customer.id,f.pixId()!);
  expect(view.payment_instructions).toBeNull();expect(view.cancel_requested_at).toBe(r.data.cancel_requested_at);
  expect((await f.pix.reconcile(f.s.customer.id,f.pixId()!)).payment_instructions).toBeNull();
  expect(f.posts()).toBe(1);
 });
 it("cancel after payment confirmed by GET is refused with CANCEL_TOO_LATE_PAYMENT_RECEIVED",async()=>{
  const f=await fixture();f.paid("payment_confirmed");
  await expect(f.cancel()).rejects.toMatchObject({code:"CANCEL_TOO_LATE_PAYMENT_RECEIVED"});
  // Progression ran on the fresh GET.
  expect(await statusOf(f.p.id)).toBe("pix_confirmed");
  expect((await eventsOf(f.p.id)).some(e=>e.reason.startsWith("CUSTOMER_CANCEL"))).toBe(false);
  // Later stages are refused without another GET.
  const gets=f.gets.length;await expect(f.cancel()).rejects.toMatchObject({code:"CANCEL_TOO_LATE_PAYMENT_RECEIVED"});
  expect(f.gets.length).toBe(gets);
 });
 it("a failed GET never records a cancel request",async()=>{
  const f=await fixture();f.setGetError(new Error("private provider failure"));
  await expect(f.cancel()).rejects.toThrow();
  expect((await eventsOf(f.p.id)).some(e=>e.reason==="CUSTOMER_CANCEL_REQUESTED")).toBe(false);
  expect((await f.pix.read(f.s.customer.id,f.pixId()!)).payment_instructions).not.toBeNull();
 });
 it("payment confirmed after cancel request proceeds to pix_confirmed and records CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT once",async()=>{
  const f=await fixture();await f.cancel();
  f.paid("payment_confirmed");await f.refresh();await f.refresh();
  expect(await statusOf(f.p.id)).toBe("pix_confirmed");
  f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();await f.refresh();
  expect(await statusOf(f.p.id)).toBe("awaiting_approval");
  const events=await eventsOf(f.p.id),withdrawn=events.filter(e=>e.reason==="CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT");
  expect(withdrawn).toHaveLength(1);
  expect(withdrawn[0]).toMatchObject({from_status:"pix_confirmed",to_status:"pix_confirmed",actor:"system:reconciliation"});
  // A second cancel after payment is too late.
  await expect(f.cancel()).rejects.toMatchObject({code:"CANCEL_TOO_LATE_PAYMENT_RECEIVED"});
 });
 it("an OZAV review entered after a withdrawn cancel still resumes (note events never count as the last transition)",async()=>{
  const f=await fixture();await f.cancel();
  f.paid("needs_review");await f.refresh();
  expect(await statusOf(f.p.id)).toBe("needs_review");
  expect((await eventsOf(f.p.id)).filter(e=>e.reason==="CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT")).toHaveLength(1);
  f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();
  expect(await statusOf(f.p.id)).toBe("awaiting_approval");
 });
 it("unpaid cancel request expires at min(Pix expiry, lock deadline)",async()=>{
  const deadline=new Date(Date.now()+60000).toISOString(),f=await fixture({facility:{...LOCKED,deadlineAt:deadline}});
  await f.cancel();
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.parse(deadline)-1000);await f.refresh();
  expect(await statusOf(f.p.id)).toBe("awaiting_pix");
  vi.setSystemTime(Date.parse(deadline)+1);await f.refresh();vi.useRealTimers();
  expect(await statusOf(f.p.id)).toBe("expired");
  const last=(await eventsOf(f.p.id)).at(-1)!;
  expect(last).toMatchObject({from_status:"awaiting_pix",to_status:"expired"});
  expect(last.reason).toBe(`PIX_EXPIRED_UNPAID: deadline=${new Date(deadline).toISOString()}; CUSTOMER_CANCEL_REQUESTED`);
  // Payment after expiry is unchanged: no withdrawal, the operator decides.
  f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();
  expect(await statusOf(f.p.id)).toBe("expired");
  expect((await eventsOf(f.p.id)).some(e=>e.reason==="CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT")).toBe(false);
  // The cancel stood until the operation closed: another request gets the same answer.
  expect(await f.cancel()).toMatchObject({replayed:true,data:{status:"expired"}});
 });
 it("an expired operation without a cancel request cannot be cancelled",async()=>{
  const deadline=new Date(Date.now()+60000).toISOString(),f=await fixture({facility:{...LOCKED,deadlineAt:deadline}});
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.parse(deadline)+1);await f.refresh();vi.useRealTimers();
  expect(await statusOf(f.p.id)).toBe("expired");
  await expect(f.cancel()).rejects.toMatchObject({code:"CANCEL_NOT_ALLOWED"});
 });
 it("cancel in accepted without Pix transfer -> expired CUSTOMER_CANCELLED; a later Pix create is refused before any POST",async()=>{
  const f=await fixture({pix:false});expect(await statusOf(f.p.id)).toBe("accepted");
  const r=await f.cancel();
  expect(r.data).toEqual({purchase_id:f.p.id,status:"expired",cancel_requested_at:expect.any(String)});
  expect((await eventsOf(f.p.id)).at(-1)).toEqual({from_status:"accepted",to_status:"expired",actor:`customer:${f.s.customer.id}`,reason:"CUSTOMER_CANCELLED"});
  await expect(f.pix.create(f.s.customer.id,randomUUID(),f.p.id)).rejects.toMatchObject({code:"PIX_PURCHASE_NOT_ELIGIBLE"});
  expect(f.posts()).toBe(0);expect(f.gets).toHaveLength(0);
 });
 it("a Pix claimed before the cancel is never expired as CUSTOMER_CANCELLED; the request is recorded and instructions stay hidden",async()=>{
  let open!:()=>void;const gate=new Promise<void>(resolve=>{open=resolve;});
  const f=await fixture({pix:false,gate});
  const creating=f.pix.create(f.s.customer.id,randomUUID(),f.p.id);
  await vi.waitFor(()=>expect(f.posts()).toBe(1));
  const r=await f.cancel();
  expect(r.data.status).toBe("accepted");expect(r.data.cancel_requested_at).toEqual(expect.any(String));
  open();const created=await creating;
  expect(created.data.status).toBe("awaiting_pix");expect(created.data.payment_instructions).toBeNull();
  expect((await eventsOf(f.p.id)).some(e=>e.reason==="CUSTOMER_CANCELLED")).toBe(false);
 });
 it("concurrent Pix create vs cancel -> exactly one wins",async()=>{
  for(let i=0;i<4;i++){
   const f=await fixture({pix:false});
   const create=()=>f.pix.create(f.s.customer.id,randomUUID(),f.p.id);
   let created:PromiseSettledResult<Awaited<ReturnType<typeof create>>>,cancelled:PromiseSettledResult<unknown>;
   if(i%2)[created,cancelled]=await Promise.allSettled([create(),f.cancel()]);
   else [cancelled,created]=await Promise.allSettled([f.cancel(),create()]);
   const expiredByCancel=(await eventsOf(f.p.id)).some(e=>e.reason==="CUSTOMER_CANCELLED");
   expect(cancelled.status).toBe("fulfilled");
   // Exactly one of: the operation expired by the cancel, or the Pix was POSTed.
   expect(Number(expiredByCancel)+f.posts()).toBe(1);
   if(expiredByCancel)expect(created.status).toBe("rejected");
   else expect(created.status==="fulfilled" && created.value.data.payment_instructions).toBeNull();
  }
 });
 it("cancel is idempotent by request_id; other customers cannot cancel",async()=>{
  const f=await fixture(),other=await setup(),requestId=randomUUID();
  await expect(f.cancel(requestId,other.customer.id)).rejects.toMatchObject({code:"CANCEL_NOT_FOUND"});
  const first=await f.cancel(requestId),again=await f.cancel(requestId);
  expect(again.replayed).toBe(true);expect(again.data).toEqual(first.data);
  // A different request after the cancel was recorded returns the same state.
  const another=await f.cancel();expect(another.replayed).toBe(true);expect(another.data).toEqual(first.data);
  expect((await eventsOf(f.p.id)).filter(e=>e.reason==="CUSTOMER_CANCEL_REQUESTED")).toHaveLength(1);
 });
 it("POST /v1/me/purchase-intents/:id/cancel",async()=>{
  const f=await fixture({pix:false});
  const app=await buildApp({customerAccess:{legal:allAcceptedLegal,customers,authenticate:async(token:string)=>{
   if(token==="owner")return{id:f.s.owner};if(token==="other")return{id:randomUUID()};throw new AuthenticationError("INVALID_TOKEN");}},
   customerPurchaseCancelService:f.cancels});apps.push(app);
  const url=`/v1/me/purchase-intents/${f.p.id}/cancel`,headers={authorization:"Bearer owner"},requestId=randomUUID();
  expect((await app.inject({method:"POST",url,payload:{request_id:requestId}})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url,headers,payload:{request_id:"nope"}})).statusCode).toBe(400);
  expect((await app.inject({method:"POST",url,headers,payload:{request_id:requestId,extra:1}})).statusCode).toBe(400);
  expect((await app.inject({method:"POST",url:"/v1/me/purchase-intents/not-a-uuid/cancel",headers,payload:{request_id:requestId}})).statusCode).toBe(400);
  const r=await app.inject({method:"POST",url,headers,payload:{request_id:requestId}});
  expect(r.statusCode).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.json()).toEqual({data:{purchase_id:f.p.id,status:"expired",cancel_requested_at:expect.any(String)},meta:{idempotent_replay:false}});
  const again=await app.inject({method:"POST",url,headers,payload:{request_id:requestId}});
  expect(again.statusCode).toBe(200);expect(again.json().meta.idempotent_replay).toBe(true);
  const disabled=await buildApp({customerAccess:{legal:allAcceptedLegal,customers,authenticate:async()=>({id:f.s.owner})}});apps.push(disabled);
  expect((await disabled.inject({method:"POST",url,headers,payload:{request_id:requestId}})).statusCode).toBe(503);
  // A purchase that cannot be cancelled anymore.
  const g=await fixture();g.paid("payment_confirmed");
  const late=await buildApp({customerAccess:{legal:allAcceptedLegal,customers,authenticate:async()=>({id:g.s.owner})},customerPurchaseCancelService:g.cancels});apps.push(late);
  const refused=await late.inject({method:"POST",url:`/v1/me/purchase-intents/${g.p.id}/cancel`,headers,payload:{request_id:randomUUID()}});
  expect(refused.statusCode).toBe(409);expect(refused.json().error.code).toBe("CANCEL_TOO_LATE_PAYMENT_RECEIVED");
  // Another customer's purchase is not found.
  const foreign=await app.inject({method:"POST",url:`/v1/me/purchase-intents/${g.p.id}/cancel`,headers,payload:{request_id:randomUUID()}});
  expect(foreign.statusCode).toBe(404);expect(foreign.json().error.code).toBe("CANCEL_NOT_FOUND");
 });
});
