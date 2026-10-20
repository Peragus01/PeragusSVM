import {randomUUID} from "node:crypto";
import {Keypair} from "@solana/web3.js";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,afterAll,beforeEach,describe,it,expect} from "vitest";
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

import {PostgresWithdrawalOperatorApprovalRepository} from "../src/repositories/postgres-withdrawal-operator-approvals.js";
import {WithdrawalOperatorApprovalService,parseWithdrawalOperators} from "../src/withdrawals/operator-approvals.js";
const approvalRepo=new PostgresWithdrawalOperatorApprovalRepository(pool);
async function approvalFixture(){
 const f=await completedFixture(),wr=await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId),operatorId=randomUUID(),user={id:operatorId,email:"operator@example.test",assuranceLevel:"aal2" as const};
 const approvals=new WithdrawalOperatorApprovalService(approvalRepo,new Set([operatorId]));
 return{...f,wr,user,approvals,approvalRequestId:randomUUID(),reason:"Reviewed the completed sandbox conversion and verified destination."};
}
async function approvalApp(f:Awaited<ReturnType<typeof approvalFixture>>,identity=f.user,enabled=true){
 const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return identity;}},...(enabled?{withdrawalOperatorApprovalService:f.approvals}:{})});apps.push(app);return app;
}

import {PostgresSandboxExecutionRepository} from "../src/repositories/postgres-sandbox-withdrawal-execution.js";
import {SandboxWithdrawalExecutionService} from "../src/withdrawals/sandbox-execution.js";
beforeEach(async()=>{await db.query("delete from peragus_sandbox_withdrawal_executions");});
async function executionFixture(){
 const f=await approvalFixture();await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
 let sends=0,identityReads=0,mode="normal",found:string|null=null;
 const sendId=`ozav_tr_${randomUUID().replaceAll('-','')}`;
 const observed={id:sendId,customerId:f.s.provider,status:"completed",sourceWalletId:"ozav_wal_testmanaged",sourceCurrency:"USDT",destinationAddress:f.s.wallet,network:"solana",sourceAmount:"200.000000",targetAmount:"199.500000",sourceLegStatus:"completed",destinationLegStatus:"completed",transactionReference:"synthetic-sandbox-reference"};
 const identity={name:"PRIVATE_SYNTHETIC_NAME",cpf:"11144477735",street:"PRIVATE_SYNTHETIC_STREET",city:"Test",country:"BR"};
 const provider={funding:{getTransfer:async()=>f.transfer},capabilities:async()=>{},identity:async()=>{identityReads++;return identity;},available:async()=>"10200.00",
  send:async(input:any)=>{sends++;expect(input.amount).toBe("200.000000");expect(input.address).toBe(f.s.wallet);expect(input.identity).toBe(identity);if(mode==="timeout")throw new Error("secret provider payload");return sendId;},
  transfer:async()=>observed,find:async()=>found} as any;
 const repo=new PostgresSandboxExecutionRepository(pool),execution=new SandboxWithdrawalExecutionService(repo,provider,f.approvals);
 return{...f,provider,repo,execution,observed,sendId,executionRequestId:randomUUID(),sends:()=>sends,identityReads:()=>identityReads,setMode:(v:string)=>{mode=v;},setFound:(v:string|null)=>{found=v;}};
}
describe("approved sandbox withdrawal execution",()=>{
 it("sends only the approved conversion amount once and does not claim real delivery",async()=>{
  const f=await executionFixture(),r=await f.execution.execute(f.user,f.wr.data.id,f.executionRequestId);
  expect(r.data).toMatchObject({state:"provider_completed",environment:"test",real_money:false,source:{amount:"200.000000"},provider_target_amount:"199.500000",provider_completed:true,onchain_delivery_verified:false,mainnet_execution:false,job_enqueued:false});
  const replay=await f.execution.execute(f.user,f.wr.data.id,f.executionRequestId);expect(replay.replayed).toBe(true);expect(replay.data.id).toBe(r.data.id);expect(f.sends()).toBe(1);
  const customer=await withdrawals.read(f.s.customer.id,f.wr.data.id);expect(customer.withdrawal_started).toBe(true);expect(customer.sandbox_execution_status).toBe("completed");expect(customer.onchain_delivery_verified).toBe(false);
  const approval=await f.approvals.read(f.user,f.wr.data.id);expect(approval.withdrawal_started).toBe(true);
  const stored=JSON.stringify((await db.query("select * from peragus_sandbox_withdrawal_executions where id=$1",[r.data.id])).rows[0]);
  for(const secret of ["PRIVATE_SYNTHETIC_NAME","11144477735","PRIVATE_SYNTHETIC_STREET"])expect(stored).not.toContain(secret);
  expect((await db.query("select count(*) as n from settlements")).rows[0]).toEqual({n:0});
 });
 it("rejects a second request key and enforces one unresolved pilot execution across customers",async()=>{
  const f=await executionFixture(),other=await executionFixture();await f.execution.execute(f.user,f.wr.data.id,f.executionRequestId);
  await expect(f.execution.execute(f.user,f.wr.data.id,randomUUID())).rejects.toThrow("WITHDRAWAL_EXECUTION_ALREADY_REQUESTED");
  await expect(other.execution.execute(other.user,other.wr.data.id,other.executionRequestId)).rejects.toThrow("WITHDRAWAL_PILOT_SLOT_UNAVAILABLE");expect(other.sends()).toBe(0);
 });
 it("makes at most one POST across racing requests",async()=>{
  const f=await executionFixture();await Promise.allSettled([f.execution.execute(f.user,f.wr.data.id,f.executionRequestId),f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)]);expect(f.sends()).toBe(1);
 });
 it("retains an uncertain timeout and recovers by listing/GET without another POST",async()=>{
  const f=await executionFixture();f.setMode("timeout");await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  const replay=await f.execution.execute(f.user,f.wr.data.id,f.executionRequestId);expect(replay.data.recovery_required).toBe(true);expect(replay.data.execution_requested).toBe(true);
  expect((await f.execution.reconcile(f.user,f.wr.data.id)).recovery_required).toBe(true);
  f.setFound(f.sendId);const recovered=await f.execution.reconcile(f.user,f.wr.data.id);expect(recovered.provider_completed).toBe(true);expect(f.sends()).toBe(1);
 });
 it("blocks changed funding, insufficient balance and unready customer before any POST",async()=>{
  for(const change of ["funding","amount","balance","identity","eligibility","approver"]){
   const f=await executionFixture();if(change==="funding")f.transfer.status="needs_review";
   if(change==="amount")f.transfer.amounts.target.amount="1.00";
   if(change==="balance")f.provider.available=async()=>"199.99";
   if(change==="identity")f.provider.identity=async()=>{throw new Error("private identity rejected");};
   if(change==="eligibility")await db.query("update peragus_customer_screenings set observation='{}' where customer_id=$1",[f.s.customer.id]);
   if(change==="approver")f.approvals.isAllowed=()=>false;
   await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();expect(f.sends()).toBe(0);
  }
 });
 it("requires allowlisted MFA operators and an existing approval",async()=>{
  const f=await executionFixture();await expect(f.execution.execute({...f.user,assuranceLevel:undefined},f.wr.data.id,f.executionRequestId)).rejects.toThrow("WITHDRAWAL_OPERATOR_MFA_REQUIRED");
  await expect(f.execution.execute({...f.user,id:randomUUID()},f.wr.data.id,f.executionRequestId)).rejects.toThrow("WITHDRAWAL_OPERATOR_REQUIRED");
  const noApproval=await completedFixture(),wr=await withdrawals.record(noApproval.s.customer.id,noApproval.withdrawalRequestId,noApproval.pixId);
  await expect(f.execution.execute(f.user,wr.data.id,randomUUID())).rejects.toThrow("WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED");expect(f.sends()).toBe(0);
 });
 it("rejects mismatched send evidence and keeps the original claim for recovery",async()=>{
  const f=await executionFixture();f.observed.destinationAddress=Keypair.generate().publicKey.toBase58();
  await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow("WITHDRAWAL_PROVIDER_CONTEXT_MISMATCH");
  const replay=await f.execution.execute(f.user,f.wr.data.id,f.executionRequestId);expect(replay.data.recovery_required).toBe(true);expect(f.sends()).toBe(1);
 });
 it("gates execution route, rejects selectors and never echoes provider or identity errors",async()=>{
  const f=await executionFixture(),url=`/v1/admin/withdrawal-requests/${f.wr.data.id}/execution`,access={customers,authenticate:async()=>f.user};
  const app=await buildApp({customerAccess:access,sandboxWithdrawalExecutionService:f.execution});apps.push(app);
  expect((await app.inject({method:"POST",url,payload:{}})).statusCode).toBe(401);
  for(const payload of [{request_id:f.executionRequestId},{request_id:f.executionRequestId,confirmation:"LIVE"},{request_id:f.executionRequestId,confirmation:"SANDBOX_ONLY",amount:"1"}])expect((await app.inject({method:"POST",url,headers,payload})).statusCode).toBe(400);
  f.setMode("timeout");const r=await app.inject({method:"POST",url,headers,payload:{request_id:f.executionRequestId,confirmation:"SANDBOX_ONLY"}});expect(r.statusCode).toBe(503);expect(r.body).not.toContain("secret provider");expect(r.headers["cache-control"]).toBe("no-store");
  const disabled=await buildApp({customerAccess:access});apps.push(disabled);expect((await disabled.inject({method:"GET",url,headers})).statusCode).toBe(503);
 });
});
