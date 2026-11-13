import { enableRuntimeControls } from "./helpers/runtime-controls.js";
// Live purchases progressing from OZAV transfer state (GET only) on a PGlite
// database recorded as 'live'. No real OZAV: the provider is a fake.
import { allAcceptedLegal } from "./helpers/legal-double.js";
import {createHash,createHmac,randomUUID} from "node:crypto";
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
import {PostgresCustomerWebhookProcessor} from "../src/repositories/postgres-customer-webhook.js";
import {CustomerPixService} from "../src/purchases/customer-sandbox-pix.js";
import {PurchaseProgression,systemRequestId} from "../src/purchases/purchase-progression.js";
import {ManualRefundService} from "../src/refunds/manual-refunds.js";
import {OperatorAlertService} from "../src/operations/operator-alerts.js";
import {CustomerWebhookConflict,type CustomerWebhookEvent} from "../src/webhooks/customer-event.js";
import type {OzavFacilityOutcome,OzavTransfer} from "../src/providers/ozav-client.js";

const db=new PGlite();let connection=Promise.resolve();
const query=async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};};
const pool={query,connect:async()=>{
 const previous=connection;let release!:()=>void;connection=new Promise<void>(resolve=>{release=resolve;});await previous;
 return{query,release};
}} as unknown as Pool;
const wide={maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}};
const customers=new PostgresCustomerRepository(pool),purchases=new PostgresCustomerPurchaseIntentRepository(pool,"live",wide);
// A TOTP verified "just now" on every read (money-moving operator actions need a fresh one).
const operator={id:randomUUID(),assuranceLevel:"aal2" as const,get mfaVerifiedAt(){return Math.floor(Date.now()/1000);}},operators=new Set([operator.id]);
const refunds=new ManualRefundService(pool,operators,true,"live",true);
const alerts=new OperatorAlertService(pool,operators,"live");
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
const count=async(table:string,purchaseId:string)=>(await db.query<{n:number}>(`select count(*)::int n from ${table} where purchase_intent_id=$1`,[purchaseId])).rows[0]!.n;
const LOCKED:OzavFacilityOutcome={locked:true,state:"locked",reason:null,amount:"200.000000",currency:"USDT",deadlineAt:"2099-01-01T00:00:00Z"};

async function fixture(options:{create?:"ok"|"timeout";facility?:OzavFacilityOutcome|null}={}){
 const s=await setup(),p=(await purchases.record(s.customer.id,randomUUID(),s.quoteId)).record,pixRepo=new PostgresCustomerPixRepository(pool,"live");
 let posts=0,listed:string|null=null;const gets:string[]=[];
 const awaiting:OzavTransfer={id:`ozav_tr_${randomUUID().replaceAll("-","")}`,status:"awaiting_payment",customerId:s.provider,quoteId:s.providerQuoteId,
  source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"000201live-br-code",qrCodeImage:null,expiresAt:new Date(Date.now()+600000).toISOString()}},
  destination:{type:"wallet",walletId:"ozav_wal_livemanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
  amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}};
 let current:OzavTransfer=awaiting;
 const provider={getCustomerCapabilities:async()=>({environment:"live",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
  getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
  getCustomerManagedWallet:async()=>"ozav_wal_livemanaged",
  createCustomerPixTransfer:async()=>{posts++;if(options.create==="timeout")throw new Error("private timeout");
   return{id:awaiting.id,transfer:awaiting,facility:options.facility===undefined?LOCKED:options.facility};},
  simulateCustomerPixPayment:async()=>{throw new Error("never in live");},
  findCustomerPixTransfer:async()=>listed,
  getTransfer:async(id:string)=>{gets.push(id);return current;}} as any;
 const pix=new CustomerPixService(pixRepo,provider,"live",purchases);
 const progression=new PurchaseProgression({pool,mode:"live",operations:purchases,
  withdrawals:new PostgresCustomerWithdrawalRequestRepository(pool,"live"),refunds,pix:{repo:pixRepo,provider}});
 let pixId:string;
 try{pixId=(await pix.create(s.customer.id,randomUUID(),p.id)).data.id;}
 catch{pixId=(await db.query<{id:string}>("select id from peragus_customer_sandbox_pix where purchase_intent_id=$1",[p.id])).rows[0]!.id;}
 const set=(patch:Partial<OzavTransfer>)=>{current={...awaiting,...patch};};
 const paid=(status:string,extra:Partial<OzavTransfer>={})=>set({status,sourceLegStatus:"completed",source:{type:"fiat_payment",currency:"BRL",rail:"pix"},...extra});
 const refresh=(actor?:string)=>progression.refreshPix(s.customer.id,pixId,actor);
 return{s,p,pixId,pix,progression,provider,awaiting,set,paid,refresh,gets,posts:()=>posts,setListed:(v:string|null)=>{listed=v;}};
}

describe("PurchaseProgression.applyTransferObservation (GET is the only source of truth)",()=>{
 it("completed transfer moves to awaiting_approval and creates exactly one withdrawal request even when processed twice",async()=>{
  const f=await fixture();expect(await statusOf(f.p.id)).toBe("awaiting_pix");
  f.paid("payment_confirmed");expect(await f.refresh()).toMatchObject({payment_confirmed:true});
  expect(await statusOf(f.p.id)).toBe("pix_confirmed");
  f.paid("completed",{destinationLegStatus:"completed"});
  await f.refresh();await f.refresh();
  expect(await statusOf(f.p.id)).toBe("awaiting_approval");
  expect(await count("peragus_customer_withdrawal_requests",f.p.id)).toBe(1);
  const w=(await db.query<any>("select request_id,amount_usdt,environment,proof_network from peragus_customer_withdrawal_requests where purchase_intent_id=$1",[f.p.id])).rows[0];
  expect(w).toEqual({request_id:systemRequestId(`system-${f.p.id}`),amount_usdt:"200.000000",environment:"live",proof_network:"solana:mainnet"});
  expect((await eventsOf(f.p.id)).slice(-3).map(e=>[e.from_status,e.to_status,e.actor])).toEqual([
   ["awaiting_pix","pix_confirmed","system:reconciliation"],["pix_confirmed","converted","system:reconciliation"],["converted","awaiting_approval","system:reconciliation"]]);
  // A stale observation never moves the operation back.
  expect(await f.progression.applyTransferObservation(f.p.id,{status:"payment_confirmed",amountUsdt:"200.000000",sourceLegStatus:"completed"})).toBe("awaiting_approval");
  expect(await statusOf(f.p.id)).toBe("awaiting_approval");
  expect(f.posts()).toBe(1);
 });
 it("is idempotent and deterministic for the system withdrawal request id",()=>{
  const id=randomUUID();
  expect(systemRequestId(`system-${id}`)).toBe(systemRequestId(`system-${id}`));
  expect(systemRequestId(`system-${id}`)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(systemRequestId(`system-${id}`)).not.toBe(systemRequestId(`system-refund-${id}`));
 });
 it("OZAV needs_review after payment (non-terminal) moves to needs_review with an alert, never refund_pending",async()=>{
  const f=await fixture();f.paid("payment_confirmed");await f.refresh();
  f.paid("needs_review");await f.refresh();await f.refresh();
  expect(await statusOf(f.p.id)).toBe("needs_review");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({from_status:"pix_confirmed",to_status:"needs_review",actor:"system:reconciliation",reason:"OZAV_TRANSFER_NEEDS_REVIEW"});
  expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(0);
  const listed=await alerts.list(operator,{kind:"operation_review",limit:"50"});
  expect(listed.data.some(a=>a.purchase_intent_id===f.p.id)).toBe(true);
 });
 it("resumes from OZAV needs_review when OZAV completes: awaiting_approval with exactly one withdrawal request",async()=>{
  const f=await fixture();f.paid("payment_confirmed");await f.refresh();
  f.paid("needs_review");await f.refresh();expect(await statusOf(f.p.id)).toBe("needs_review");
  f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();await f.refresh();
  expect(await statusOf(f.p.id)).toBe("awaiting_approval");
  expect(await count("peragus_customer_withdrawal_requests",f.p.id)).toBe(1);
  expect((await eventsOf(f.p.id)).slice(-3).map(e=>[e.from_status,e.to_status])).toEqual([
   ["pix_confirmed","needs_review"],["needs_review","converted"],["converted","awaiting_approval"]]);
 });
 it("OZAV needs_review then failed after payment goes to refund_pending",async()=>{
  const f=await fixture();f.paid("needs_review");await f.refresh();expect(await statusOf(f.p.id)).toBe("needs_review");
  f.paid("failed");await f.refresh();
  expect(await statusOf(f.p.id)).toBe("refund_pending");expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(1);
  const listed=await alerts.list(operator,{kind:"refund_pending_review",limit:"50"});
  expect(listed.data.some(a=>a.purchase_intent_id===f.p.id)).toBe(true);
 });
 it("never resumes a review that progression did not get from OZAV (lock outcome unknown, amount below lock)",async()=>{
  const f=await fixture({create:"timeout"});f.setListed(f.awaiting.id);
  await db.query("update peragus_customer_sandbox_pix set created_at=now()-interval '10 minutes' where id=$1",[f.pixId]);
  await f.refresh();expect((await eventsOf(f.p.id)).at(-1)!.reason).toMatch(/^PIX_LOCK_OUTCOME_UNKNOWN/);
  f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();
  expect(await statusOf(f.p.id)).toBe("needs_review");expect(await count("peragus_customer_withdrawal_requests",f.p.id)).toBe(0);
  f.paid("failed");
  expect(await f.progression.applyTransferObservation(f.p.id,{status:"failed",amountUsdt:null,sourceLegStatus:"completed"})).toBe("needs_review");
  const g=await fixture();g.paid("completed",{destinationLegStatus:"completed",amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"1.000000"}}});
  await g.refresh();expect((await eventsOf(g.p.id)).at(-1)!.reason).toMatch(/^CONVERTED_AMOUNT_BELOW_LOCK/);
  expect(await g.progression.applyTransferObservation(g.p.id,{status:"completed",amountUsdt:"200.000000",sourceLegStatus:"completed"})).toBe("needs_review");
  expect(await count("peragus_customer_withdrawal_requests",g.p.id)).toBe(0);
 });
 it("an expired operation whose transfer later completes raises pix_open_after_close (money in custody)",async()=>{
  const deadline=new Date(Date.now()+60000).toISOString(),f=await fixture({facility:{...LOCKED,deadlineAt:deadline}});
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.parse(deadline)+1);
  await f.refresh();expect(await statusOf(f.p.id)).toBe("expired");
  vi.useRealTimers();
  f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();
  expect(await statusOf(f.p.id)).toBe("expired");
  const listed=await alerts.list(operator,{kind:"pix_open_after_close",limit:"50"});
  expect(listed.data.find(a=>a.purchase_intent_id===f.p.id)).toMatchObject({severity:"high",pix_id:f.pixId});
 });
 it("refund completion fails explicitly when the operation is not refund_pending, and records nothing",async()=>{
  const f=await fixture();f.paid("failed");await f.refresh();
  const r=(await db.query<any>("select id from peragus_customer_refund_requests where purchase_intent_id=$1",[f.p.id])).rows[0];
  await refunds.decide(operator,r.id,randomUUID(),"approved","Pix received, transfer failed at OZAV.");
  // Operator moves the case back to review before the money was returned.
  await purchases.transitionOperation(f.p.id,"needs_review","operator:test","refund on hold");
  await expect(refunds.complete(operator,r.id,randomUUID(),"1000.00","manual-pix-return-0002")).rejects.toMatchObject({code:"REFUND_OPERATION_NOT_REFUND_PENDING"});
  expect((await db.query("select count(*)::int n from peragus_manual_refund_completions where refund_request_id=$1",[r.id])).rows[0]).toEqual({n:0});
  expect(await statusOf(f.p.id)).toBe("needs_review");
 });
 it("refund_pending creates exactly one manual refund request and completing it moves the operation to refunded",async()=>{
  const f=await fixture();f.paid("failed");
  await f.refresh();await f.refresh();
  expect(await statusOf(f.p.id)).toBe("refund_pending");
  expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(1);
  const r=(await db.query<any>("select id,request_id,amount_brl,environment from peragus_customer_refund_requests where purchase_intent_id=$1",[f.p.id])).rows[0];
  expect(r).toMatchObject({request_id:systemRequestId(`system-refund-${f.p.id}`),amount_brl:"1000.00",environment:"live"});
  await refunds.decide(operator,r.id,randomUUID(),"approved","Pix received, transfer failed at OZAV.");
  expect(await statusOf(f.p.id)).toBe("refund_pending");
  await refunds.complete(operator,r.id,randomUUID(),"1000.00","manual-pix-return-0001");
  expect(await statusOf(f.p.id)).toBe("refunded");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({from_status:"refund_pending",to_status:"refunded",actor:`operator:${operator.id}`});
  await f.refresh();expect(await statusOf(f.p.id)).toBe("refunded");
 });
 it("failed, cancelled or expired transfers without payment end the operation failed or expired",async()=>{
  for(const [status,expected] of [["failed","failed"],["cancelled","failed"],["expired","expired"]] as const){
   const f=await fixture();f.set({status,source:{type:"fiat_payment",currency:"BRL",rail:"pix"}});await f.refresh();
   expect(await statusOf(f.p.id)).toBe(expected);
   expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(0);
  }
 });
 it("needs_review before payment holds the operation for review without a refund",async()=>{
  const f=await fixture();f.set({status:"needs_review",source:{type:"fiat_payment",currency:"BRL",rail:"pix"}});await f.refresh();
  expect(await statusOf(f.p.id)).toBe("needs_review");expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(0);
  const listed=await alerts.list(operator,{kind:"operation_review",limit:"50"});
  expect(listed.data.some(a=>a.purchase_intent_id===f.p.id)).toBe(true);
 });
 it("expires awaiting_pix once the earlier of Pix expiry and lock deadline passes, confirmed by GET",async()=>{
  const deadline=new Date(Date.now()+60000).toISOString(),f=await fixture({facility:{...LOCKED,deadlineAt:deadline}});
  await f.refresh();expect(await statusOf(f.p.id)).toBe("awaiting_pix");
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.parse(deadline)+1);
  const before=f.gets.length;await f.refresh();
  expect(f.gets.length).toBe(before+1);
  expect(await statusOf(f.p.id)).toBe("expired");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({from_status:"awaiting_pix",to_status:"expired",reason:`PIX_EXPIRED_UNPAID: deadline=${deadline}`});
 });
 it("does not expire when the GET shows the payment arrived",async()=>{
  const deadline=new Date(Date.now()+60000).toISOString(),f=await fixture({facility:{...LOCKED,deadlineAt:deadline}});
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.parse(deadline)+1);
  f.paid("payment_confirmed");await f.refresh();expect(await statusOf(f.p.id)).toBe("pix_confirmed");
 });
 it("a completed conversion below the locked amount goes to review, never to approval",async()=>{
  const f=await fixture();f.paid("completed",{destinationLegStatus:"completed",amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"199.999999"}}});
  await f.refresh();
  expect(await statusOf(f.p.id)).toBe("needs_review");
  expect((await eventsOf(f.p.id)).at(-1)!.reason).toBe("CONVERTED_AMOUNT_BELOW_LOCK: amount=199.999999 locked_usdt_amount=200.000000");
  expect(await count("peragus_customer_withdrawal_requests",f.p.id)).toBe(0);
 });
});

describe("ambiguous live Pix create recovered by GET",()=>{
 it("found transfer with unknown lock outcome goes to needs_review with an alert, never re-POSTs or shows instructions",async()=>{
  const f=await fixture({create:"timeout"});expect(await statusOf(f.p.id)).toBe("accepted");
  f.setListed(f.awaiting.id);
  // Within the grace period the create may still be finishing: nothing moves.
  expect((await f.refresh()).payment_instructions).toBeNull();expect(await statusOf(f.p.id)).toBe("accepted");
  await db.query("update peragus_customer_sandbox_pix set created_at=now()-interval '10 minutes' where id=$1",[f.pixId]);
  const view=await f.refresh();
  expect(view.payment_instructions).toBeNull();
  expect(await statusOf(f.p.id)).toBe("needs_review");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({from_status:"accepted",to_status:"needs_review",reason:"PIX_LOCK_OUTCOME_UNKNOWN: transfer_status=awaiting_payment"});
  expect(f.posts()).toBe(1);
  const listed=await alerts.list(operator,{kind:"operation_review",limit:"50"});
  expect(listed.data.some(a=>a.purchase_intent_id===f.p.id)).toBe(true);
 });
 it("found transfer that expired unpaid releases the slot as expired",async()=>{
  const f=await fixture({create:"timeout"});f.setListed(f.awaiting.id);
  await db.query("update peragus_customer_sandbox_pix set created_at=now()-interval '10 minutes' where id=$1",[f.pixId]);
  f.set({status:"expired",source:{type:"fiat_payment",currency:"BRL",rail:"pix"}});await f.refresh();
  expect(await statusOf(f.p.id)).toBe("expired");expect(f.posts()).toBe(1);
 });
 it("an empty listing keeps the operation accepted (no proof that nothing exists)",async()=>{
  const f=await fixture({create:"timeout"});
  await db.query("update peragus_customer_sandbox_pix set created_at=now()-interval '10 minutes' where id=$1",[f.pixId]);
  await f.refresh();expect(await statusOf(f.p.id)).toBe("accepted");expect(f.gets).toHaveLength(0);
 });
 it("final review I3: still no transfer listed 30 minutes after the claim expires the accepted operation (never with a transfer)",async()=>{
  const f=await fixture({create:"timeout"});
  await db.query("update peragus_customer_sandbox_pix set updated_at=now()-interval '29 minutes' where id=$1",[f.pixId]);
  await f.refresh();expect(await statusOf(f.p.id)).toBe("accepted");
  await db.query("update peragus_customer_sandbox_pix set updated_at=now()-interval '31 minutes' where id=$1",[f.pixId]);
  await f.refresh();expect(await statusOf(f.p.id)).toBe("expired");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({from_status:"accepted",to_status:"expired",reason:expect.stringMatching(/^PIX_CREATE_NOT_FOUND_AFTER_GRACE/)});
  expect(f.posts()).toBe(1);
  // A listed transfer is never expired by the grace rule.
  const g=await fixture({create:"timeout"});g.setListed(g.awaiting.id);
  await db.query("update peragus_customer_sandbox_pix set updated_at=now()-interval '31 minutes',created_at=now()-interval '31 minutes' where id=$1",[g.pixId]);
  await g.refresh();expect(await statusOf(g.p.id)).toBe("needs_review");
  expect(await g.progression.expireCreateNotFound(g.p.id)).toBe(false);
 });
 it("final review I3: accepted operations without a claimed Pix expire after the TTL",async()=>{
  const s=await setup(),idle=(await purchases.record(s.customer.id,randomUUID(),s.quoteId)).record;
  const progression=new PurchaseProgression({pool,mode:"live",operations:purchases,withdrawals:new PostgresCustomerWithdrawalRequestRepository(pool,"live"),refunds});
  expect(await progression.expireAbandonedAccepted(30*60_000)).toBe(0);
  // Fixture only: the status guard keeps status_changed_at, so age it with triggers off.
  const age=async(id:string)=>{await db.exec("set session_replication_role=replica");
   try{await db.query("update peragus_customer_purchase_intents set status_changed_at=now()-interval '31 minutes' where id=$1",[id]);}finally{await db.exec("set session_replication_role=origin");}};
  await age(idle.id);
  // A claimed (attempted) Pix keeps its operation: only the grace rule above may expire it.
  const claimed=await fixture({create:"timeout"});
  await age(claimed.p.id);
  expect(await progression.expireAbandonedAccepted(30*60_000)).toBe(1);
  expect(await statusOf(idle.id)).toBe("expired");expect(await statusOf(claimed.p.id)).toBe("accepted");
  expect((await eventsOf(idle.id)).at(-1)).toMatchObject({from_status:"accepted",to_status:"expired",reason:"ACCEPTED_TTL_EXPIRED_NO_PIX"});
 });
 it("Ruling 39: an unpaid PIX_LOCK_OUTCOME_UNKNOWN review closes as failed when OZAV reports the transfer terminal and unpaid",async()=>{
  const f=await fixture({create:"timeout"});f.setListed(f.awaiting.id);
  await db.query("update peragus_customer_sandbox_pix set created_at=now()-interval '10 minutes' where id=$1",[f.pixId]);
  await f.refresh();expect(await statusOf(f.p.id)).toBe("needs_review");
  f.set({status:"expired",source:{type:"fiat_payment",currency:"BRL",rail:"pix"}});await f.refresh();
  expect(await statusOf(f.p.id)).toBe("failed");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({from_status:"needs_review",to_status:"failed",reason:expect.stringMatching(/^PIX_TRANSFER_EXPIRED_UNPAID/)});
  // A paid ending is never auto-closed.
  const g=await fixture({create:"timeout"});g.setListed(g.awaiting.id);
  await db.query("update peragus_customer_sandbox_pix set created_at=now()-interval '10 minutes' where id=$1",[g.pixId]);
  await g.refresh();g.paid("failed");await g.refresh();expect(await statusOf(g.p.id)).toBe("needs_review");
 });
 it("a not_locked transfer that stays payable at OZAV raises an operator alert (OZAV has no cancel endpoint)",async()=>{
  const f=await fixture({facility:{locked:false,state:"not_locked",reason:null,amount:null,currency:null,deadlineAt:null}});
  expect(await statusOf(f.p.id)).toBe("failed");
  await f.refresh();expect(await statusOf(f.p.id)).toBe("failed");
  const listed=await alerts.list(operator,{kind:"pix_open_after_close",limit:"50"});
  expect(listed.data.find(a=>a.purchase_intent_id===f.p.id)).toMatchObject({severity:"high",pix_id:f.pixId});
  f.set({status:"expired",source:{type:"fiat_payment",currency:"BRL",rail:"pix"}});await f.refresh();
  expect((await alerts.list(operator,{kind:"pix_open_after_close",limit:"50"})).data.some(a=>a.purchase_intent_id===f.p.id)).toBe(false);
 });
});

describe("stale concurrent moves and resume without going backwards",()=>{
 it("transitionOperation refuses a move decided from a status that changed meanwhile",async()=>{
  const f=await fixture();
  await expect(purchases.transitionOperation(f.p.id,"pix_confirmed","system:test","stale",{from:"accepted"})).rejects.toMatchObject({code:"OPERATION_INVALID_TRANSITION"});
  await expect(purchases.transitionOperation(f.p.id,"needs_review","system:test","stale",{from:"awaiting_pix",lastReason:"something else"})).rejects.toMatchObject({code:"OPERATION_INVALID_TRANSITION"});
  expect(await statusOf(f.p.id)).toBe("awaiting_pix");
 });
 it("a stale progression never moves a needs_review (WITHDRAWAL_REQUEST_NOT_RECORDED) to converted",async()=>{
  const f=await fixture();f.paid("payment_confirmed");await f.refresh();f.paid("needs_review");await f.refresh();
  expect((await eventsOf(f.p.id)).at(-1)!.reason).toBe("OZAV_TRANSFER_NEEDS_REVIEW");
  let raced=false;
  const racing={transitionOperation:async(id:string,to:any,actor:string,reason:string,expected?:any)=>{
   if(!raced){raced=true; // A concurrent worker resumes and ends in a non-resumable review first.
    await purchases.transitionOperation(id,"converted","system:other","transfer_completed",{from:"needs_review",lastReason:"OZAV_TRANSFER_NEEDS_REVIEW"});
    await purchases.transitionOperation(id,"needs_review","system:other","WITHDRAWAL_REQUEST_NOT_RECORDED: WITHDRAWAL_PREREQUISITES_NOT_RECORDED",{from:"converted"});}
   return purchases.transitionOperation(id,to,actor,reason,expected);}};
  const stale=new PurchaseProgression({pool,mode:"live",operations:racing,withdrawals:new PostgresCustomerWithdrawalRequestRepository(pool,"live"),refunds});
  await expect(stale.applyTransferObservation(f.p.id,{status:"completed",amountUsdt:"200.000000",sourceLegStatus:"completed"})).rejects.toMatchObject({code:"OPERATION_INVALID_TRANSITION"});
  expect(await statusOf(f.p.id)).toBe("needs_review");
  expect((await eventsOf(f.p.id)).at(-1)!.reason).toMatch(/^WITHDRAWAL_REQUEST_NOT_RECORDED/);
  expect(await count("peragus_customer_withdrawal_requests",f.p.id)).toBe(0);
 });
 it("resumes relative to the stage the OZAV review was entered from, never backwards",async()=>{
  const f=await fixture();f.paid("payment_confirmed");await f.refresh();
  await purchases.transitionOperation(f.p.id,"converted","system:test","synthetic converted stage");
  expect(await f.progression.applyTransferObservation(f.p.id,{status:"needs_review",amountUsdt:"200.000000",sourceLegStatus:"completed"})).toBe("needs_review");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({from_status:"converted",reason:"OZAV_TRANSFER_NEEDS_REVIEW"});
  expect(await f.progression.applyTransferObservation(f.p.id,{status:"payment_confirmed",amountUsdt:"200.000000",sourceLegStatus:"completed"})).toBe("needs_review");
  f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();
  expect(await statusOf(f.p.id)).toBe("awaiting_approval");
  expect((await eventsOf(f.p.id)).slice(-2).map(e=>[e.from_status,e.to_status])).toEqual([["needs_review","converted"],["converted","awaiting_approval"]]);
 });
});

describe("operator refund decision (POST /v1/admin/operations/:purchaseId/refund-decision)",()=>{
 const reasonText="Operator decided to return the Pix payment.";
 const appWith=async(owner:string)=>{
  // Production wiring: the same service the server builds (settleOperations=true).
  const service=new ManualRefundService(pool,operators,true,"live",true);
  const app=await buildApp({customerAccess:{ legal: allAcceptedLegal,customers,authenticate:async(token:string)=>{
   if(token==="operator")return operator;if(token==="customer")return{id:owner};
   if(token==="stale")return{id:operator.id,assuranceLevel:"aal2",mfaVerifiedAt:Math.floor(Date.now()/1000)-301};if(token==="aal1")return{id:operator.id};throw new AuthenticationError("INVALID_TOKEN");}},manualRefundService:service});
  apps.push(app);return app;
 };
 const decide=(app:Awaited<ReturnType<typeof buildApp>>,purchaseId:string,body:Record<string,unknown>,token="operator")=>
  app.inject({method:"POST",url:`/v1/admin/operations/${purchaseId}/refund-decision`,headers:{authorization:`Bearer ${token}`},payload:body});
 const paidAt=async(stage:"needs_review"|"pix_confirmed"|"converted"|"awaiting_approval"|"expired"|"failed")=>{
  const f=await fixture();f.paid("payment_confirmed");await f.refresh();
  if(stage==="needs_review"){f.paid("needs_review");await f.refresh();}
  if(stage==="converted")await purchases.transitionOperation(f.p.id,"converted","system:test","synthetic stage");
  if(stage==="awaiting_approval"){f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();}
  if(stage==="expired" || stage==="failed"){
   // A closed operation whose Pix was nevertheless paid (e.g. paid after the lock deadline).
   await db.exec("alter table peragus_customer_purchase_intents disable trigger peragus_purchase_status_guard");
   try{await db.query("update peragus_customer_purchase_intents set status=$2 where id=$1",[f.p.id,stage]);}
   finally{await db.exec("alter table peragus_customer_purchase_intents enable trigger peragus_purchase_status_guard");}
  }
  expect(await statusOf(f.p.id)).toBe(stage);return f;
 };
 it.each(["needs_review","pix_confirmed","converted","awaiting_approval","expired","failed"] as const)("moves a paid %s operation to refund_pending, audited and idempotent",async stage=>{
  const f=await paidAt(stage),app=await appWith(f.s.owner),requestId=randomUUID();
  const first=await decide(app,f.p.id,{request_id:requestId,reason:reasonText});
  expect(first.statusCode,first.body).toBe(201);
  expect(first.json().data).toMatchObject({purchase_intent_id:f.p.id,status:"refund_pending",refund_request:{state:"pending_review",requested_amount:{amount:"1000.00"}}});
  expect(await statusOf(f.p.id)).toBe("refund_pending");
  expect((await eventsOf(f.p.id)).at(-1)).toEqual({from_status:stage,to_status:"refund_pending",actor:`operator:${operator.id}`,reason:`OPERATOR_REFUND_DECISION: ${reasonText}`});
  const again=await decide(app,f.p.id,{request_id:requestId,reason:reasonText});
  expect(again.statusCode).toBe(200);expect(again.json().meta.idempotent_replay).toBe(true);
  expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(1);
  expect((await db.query("select count(*)::int n from peragus_operator_refund_decisions where purchase_id=$1",[f.p.id])).rows[0]).toEqual({n:1});
  expect((await decide(app,f.p.id,{request_id:requestId,reason:"A different reason for the same request."})).json().error.code).toBe("REFUND_IDEMPOTENCY_CONFLICT");
 });
 it("refuses unpaid expired or failed operations (service and SQL guard) and changes nothing",async()=>{
  for(const status of ["expired","failed"] as const){
   const f=await fixture();f.set({status,source:{type:"fiat_payment",currency:"BRL",rail:"pix"}});await f.refresh();
   expect(await statusOf(f.p.id)).toBe(status);
   const app=await appWith(f.s.owner),r=await decide(app,f.p.id,{request_id:randomUUID(),reason:reasonText});
   expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("REFUND_PAYMENT_NOT_CONFIRMED");
   expect(await statusOf(f.p.id)).toBe(status);expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(0);
   await expect(purchases.transitionOperation(f.p.id,"refund_pending","system:test","bypass the service")).rejects.toMatchObject({code:"OPERATION_INVALID_TRANSITION"});
  }
 });
 it("requires an allowlisted AAL2 operator and a valid body",async()=>{
  const f=await paidAt("pix_confirmed"),app=await appWith(f.s.owner);
  expect((await decide(app,f.p.id,{request_id:randomUUID(),reason:reasonText},"aal1")).statusCode).toBe(403);
  expect((await decide(app,f.p.id,{request_id:randomUUID(),reason:reasonText},"customer")).statusCode).toBe(403);
  expect((await decide(app,f.p.id,{request_id:randomUUID(),reason:"x".repeat(501)})).statusCode).toBe(400);
  expect((await decide(app,f.p.id,{request_id:randomUUID()})).statusCode).toBe(400);
  expect(await statusOf(f.p.id)).toBe("pix_confirmed");
 });
 it("requires a fresh TOTP for the refund decision and changes nothing with a stale one",async()=>{
  const f=await paidAt("pix_confirmed"),app=await appWith(f.s.owner);
  const r=await decide(app,f.p.id,{request_id:randomUUID(),reason:reasonText},"stale");
  expect(r.statusCode).toBe(403);expect(r.json().error.code).toBe("OPERATOR_MFA_STALE");
  expect(await statusOf(f.p.id)).toBe("pix_confirmed");expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(0);
 });
 it("end to end: customer request -> operator decision -> completion -> refunded, clearing the alert",async()=>{
  const deadline=new Date(Date.now()+60000).toISOString(),f=await fixture({facility:{...LOCKED,deadlineAt:deadline}});
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.parse(deadline)+1);await f.refresh();vi.useRealTimers();
  expect(await statusOf(f.p.id)).toBe("expired");
  f.paid("completed",{destinationLegStatus:"completed"});await f.refresh();
  expect((await alerts.list(operator,{kind:"pix_open_after_close",limit:"50"})).data.some(a=>a.purchase_intent_id===f.p.id)).toBe(true);
  const app=await appWith(f.s.owner),customerHeaders={authorization:"Bearer customer"},operatorHeaders={authorization:"Bearer operator"};
  const asked=await app.inject({method:"POST",url:`/v1/me/operations/${f.p.id}/refund-request`,headers:customerHeaders,payload:{request_id:randomUUID(),reason:"I want my Pix payment back, please."}});
  expect(asked.statusCode).toBe(201);
  const decided=await decide(app,f.p.id,{request_id:randomUUID(),reason:reasonText});
  expect(decided.statusCode).toBe(201);expect(decided.json().data.refund_request.id).toBe(asked.json().data.id);
  expect(await count("peragus_customer_refund_requests",f.p.id)).toBe(1);
  expect((await alerts.list(operator,{kind:"pix_open_after_close",limit:"50"})).data.some(a=>a.purchase_intent_id===f.p.id)).toBe(false);
  const refundId=asked.json().data.id;
  expect((await app.inject({method:"POST",url:`/v1/admin/refund-requests/${refundId}/decision`,headers:operatorHeaders,
   payload:{request_id:randomUUID(),decision:"approved",reason:"Approved after manual review.",confirmation:"MANUAL_REVIEW_COMPLETED"}})).statusCode).toBe(201);
  const done=await app.inject({method:"POST",url:`/v1/admin/refund-requests/${refundId}/completion`,headers:operatorHeaders,
   payload:{request_id:randomUUID(),amount_brl:"1000.00",reference:"pix-return-e2e-0001",confirmation:"MANUAL_REFUND_EXECUTED_EXTERNALLY"}});
  expect(done.statusCode).toBe(201);
  expect(await statusOf(f.p.id)).toBe("refunded");
  expect((await eventsOf(f.p.id)).slice(-2).map(e=>[e.from_status,e.to_status,e.actor])).toEqual([
   ["expired","refund_pending",`operator:${operator.id}`],["refund_pending","refunded",`operator:${operator.id}`]]);
  expect((await alerts.list(operator,{kind:"all",limit:"50"})).data.some(a=>a.purchase_intent_id===f.p.id)).toBe(false);
 });
});

const secret="ozav_whsec_live_do_not_strip_prefix";
const transferEvent=(transfer:Record<string,unknown>,livemode=true,type="transfer.completed"):CustomerWebhookEvent=>({
 id:`ozav_evt_${randomUUID().replaceAll("-","")}`,object:"event",type,livemode,created_at:new Date().toISOString(),data:{transfer}});
const digest=(e:CustomerWebhookEvent)=>createHash("sha256").update(JSON.stringify(e)).digest("hex");
describe("transfer.* webhooks in live",()=>{
 const processorFor=(f:Awaited<ReturnType<typeof fixture>>)=>new PostgresCustomerWebhookProcessor(pool,{} as any,"live",f.progression);
 it("webhook body status is never trusted; state follows GET /v2/transfers/{id}",async()=>{
  const f=await fixture(),processor=processorFor(f);
  const e=transferEvent({id:f.awaiting.id,status:"completed",source_leg:{status:"completed"}});
  expect(await processor.process(e,digest(e))).toBe("processed");
  expect(f.gets.at(-1)).toBe(f.awaiting.id);
  expect(await statusOf(f.p.id)).toBe("awaiting_pix");
  expect(await count("peragus_customer_withdrawal_requests",f.p.id)).toBe(0);
  f.paid("payment_confirmed");
  const failed=transferEvent({id:f.awaiting.id,status:"failed"},true,"transfer.failed");
  expect(await processor.process(failed,digest(failed))).toBe("processed");
  expect(await statusOf(f.p.id)).toBe("pix_confirmed");
  expect((await eventsOf(f.p.id)).at(-1)).toMatchObject({actor:"system:webhook",to_status:"pix_confirmed"});
  expect(await processor.process(failed,digest(failed))).toBe("duplicate");
  await expect(processor.process({...failed,data:{transfer:{id:f.awaiting.id}}},"b".repeat(64))).rejects.toBeInstanceOf(CustomerWebhookConflict);
  const unknown=transferEvent({id:`ozav_tr_${randomUUID().replaceAll("-","")}`});
  expect(await processor.process(unknown,digest(unknown))).toBe("ignored");
  expect(f.posts()).toBe(1);
 });
 it("webhook with livemode opposite to the mode is ignored and changes nothing",async()=>{
  const f=await fixture(),processor=processorFor(f);f.paid("payment_confirmed");
  const app=await buildApp({customerWebhooks:{secret,processor,mode:"live"}});apps.push(app);
  const e=transferEvent({id:f.awaiting.id},false),raw=JSON.stringify(e),t=Math.floor(Date.now()/1000);
  const r=await app.inject({method:"POST",url:"/webhooks/customer-updates",payload:raw,headers:{"content-type":"application/json",
   "x-ozav-signature":`t=${t},v1=${createHmac("sha256",secret).update(`${t}.${raw}`).digest("hex")}`,"x-ozav-event-id":e.id}});
  expect(r.json()).toEqual({received:true,result:"ignored_environment"});
  expect(f.gets).toHaveLength(0);expect(await statusOf(f.p.id)).toBe("awaiting_pix");
  expect((await db.query("select count(*)::int n from peragus_customer_webhook_events where event_id=$1",[e.id])).rows[0]).toEqual({n:0});
  await expect(processor.process(e,digest(e))).rejects.toBeInstanceOf(CustomerWebhookConflict);
  expect(f.gets).toHaveLength(0);expect(await statusOf(f.p.id)).toBe("awaiting_pix");
 });
});
