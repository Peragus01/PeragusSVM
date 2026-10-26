import {SandboxWithdrawalRecoveryService,createSandboxRecoveryReader} from "../src/withdrawals/sandbox-recovery.js";
import {OperatorWithdrawalAuditService} from "../src/withdrawals/operator-withdrawal-audit.js";
import {OperatorWithdrawalQueueService} from "../src/withdrawals/operator-withdrawal-queue.js";
import {CustomerOperationHistoryService,parseHistoryQuery} from "../src/purchases/customer-operation-history.js";
import {CustomerWithdrawalResultService} from "../src/withdrawals/customer-withdrawal-results.js";
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
 it("recovers through GET-only provider capability while execution remains disabled",async()=>{
  const f=await executionFixture();f.setMode("timeout");
  await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  f.setFound(f.sendId);f.provider.transfer=async()=>({...f.observed,targetAmount:null});
  const recovery=new SandboxWithdrawalRecoveryService(f.repo,{find:f.provider.find,transfer:f.provider.transfer},new Set([f.user.id]));
  expect(recovery).not.toHaveProperty("execute");
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>f.user},sandboxWithdrawalRecoveryService:recovery});apps.push(app);
  const path=`/v1/admin/withdrawal-requests/${f.wr.data.id}/execution`,headers={authorization:"Bearer valid"};
  const before=await app.inject({method:"GET",url:path,headers});
  expect(before.statusCode).toBe(200);expect(before.json().data.recovery_required).toBe(true);
  const recovered=await app.inject({method:"POST",url:path+"/reconcile",headers});
  expect(recovered.statusCode).toBe(200);expect(recovered.headers["cache-control"]).toBe("no-store");
  expect(recovered.json().data).toMatchObject({provider_completed:true,recovery_required:false,provider_target_amount:null,pilot_slot_held:true,onchain_delivery_verified:false});
  const blocked=await app.inject({method:"POST",url:path,headers,payload:{request_id:randomUUID(),confirmation:"SANDBOX_ONLY"}});
  expect(blocked.statusCode).toBe(503);expect(blocked.json().error.code).toBe("SANDBOX_WITHDRAWAL_EXECUTION_DISABLED");
  expect(f.sends()).toBe(1);
 });
 it("never creates an execution during recovery and skips providers for an unattempted reservation",async()=>{
  const f=await executionFixture();let reads=0;
  const recovery=new SandboxWithdrawalRecoveryService(f.repo,{find:async()=>{reads++;return null;},transfer:async()=>{reads++;return f.observed as any;}},new Set([f.user.id]));
  await expect(recovery.reconcile(f.user,f.wr.data.id)).rejects.toThrow("WITHDRAWAL_EXECUTION_NOT_FOUND");
  const context=(await f.repo.context(f.wr.data.id))!;await f.repo.reserve(f.user.id,f.executionRequestId,context);
  expect(await recovery.reconcile(f.user,f.wr.data.id)).toMatchObject({state:"reserved",execution_requested:false,recovery_required:false});
  expect(reads).toBe(0);expect(f.sends()).toBe(0);
 });
 it("retains unknown outcomes and rejects mismatched evidence or unauthorized recovery",async()=>{
  const f=await executionFixture();f.setMode("timeout");await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  const recovery=new SandboxWithdrawalRecoveryService(f.repo,{find:f.provider.find,transfer:f.provider.transfer},new Set([f.user.id]));
  expect(await recovery.reconcile(f.user,f.wr.data.id)).toMatchObject({state:"uncertain",recovery_required:true});
  f.setFound(f.sendId);f.observed.destinationAddress=Keypair.generate().publicKey.toBase58();
  await expect(recovery.reconcile(f.user,f.wr.data.id)).rejects.toThrow("WITHDRAWAL_PROVIDER_CONTEXT_MISMATCH");
  expect(await recovery.read(f.user,f.wr.data.id)).toMatchObject({state:"uncertain",recovery_required:true});
  await expect(recovery.read({id:f.user.id},f.wr.data.id)).rejects.toThrow("WITHDRAWAL_OPERATOR_MFA_REQUIRED");
  await expect(recovery.read({id:randomUUID(),assuranceLevel:"aal2"},f.wr.data.id)).rejects.toThrow("WITHDRAWAL_OPERATOR_REQUIRED");
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:f.s.owner,assuranceLevel:"aal2"})},sandboxWithdrawalRecoveryService:recovery});apps.push(app);
  const denied=await app.inject({method:"POST",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/execution/reconcile`,headers:{authorization:"Bearer valid"}});
  expect(denied.statusCode).toBe(403);expect(denied.json().error.code).toBe("OPERATOR_ACCOUNT_SEPARATION_REQUIRED");
  expect(f.sends()).toBe(1);
 });
 it("exposes only read methods from the sandbox recovery provider",()=>{
  expect(()=>createSandboxRecoveryReader("ozav_sk_live_example")).toThrow("Sandbox key required");
  const reader=createSandboxRecoveryReader("ozav_sk_test_example");
  expect(Object.keys(reader).sort()).toEqual(["find","transfer"]);expect(Object.isFrozen(reader)).toBe(true);
 });
 it("reads stored audit before approval and after completion with writes disabled",async()=>{
  const f=await approvalFixture(),audit=new OperatorWithdrawalAuditService(pool,new Set([f.user.id]));
  const before=await audit.read(f.user,f.wr.data.id);
  expect(before).toMatchObject({withdrawal_request_id:f.wr.data.id,approval:null,execution:null,pix:{conversion_completed:true},integrity:{purchase_matches:true,pix_matches:true,converted_amount_matches:true,approval_matches:null,execution_matches:null}});
  await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
  const approved=await audit.read(f.user,f.wr.data.id);
  expect(approved.approval).toMatchObject({operator_user_id:f.user.id,reason:f.reason,assurance_level:"aal2"});
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>f.user},operatorWithdrawalAuditService:audit});apps.push(app);
  const response=await app.inject({method:"GET",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/audit`,headers:{authorization:"Bearer valid"}});
  expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json().data.execution_authorized).toBe(false);
  for(const secret of [f.s.provider,"proof_signature","encrypted","provider_customer_id",'"request_id"',"travel_rule"])expect(response.body).not.toContain(secret);
  expect((await app.inject({method:"POST",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/execution`,headers:{authorization:"Bearer valid"},payload:{request_id:randomUUID(),confirmation:"SANDBOX_ONLY"}})).statusCode).toBe(503);
 });
 it("audits uncertain recovery and retains unknown net amounts without repeating sends",async()=>{
  const f=await executionFixture(),audit=new OperatorWithdrawalAuditService(pool,new Set([f.user.id]));
  f.setMode("timeout");await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  const uncertain=await audit.read(f.user,f.wr.data.id);
  expect(uncertain.execution).toMatchObject({state:"uncertain",withdrawal_started:true,recovery_required:true,provider_target_amount:null,pilot_slot_held:true});
  f.setFound(f.sendId);f.provider.transfer=async()=>({...f.observed,targetAmount:null});
  await f.execution.reconcile(f.user,f.wr.data.id);
  const complete=await audit.read(f.user,f.wr.data.id);
  expect(complete).toMatchObject({execution:{state:"provider_completed",provider_completed:true,provider_target_amount:null,recovery_required:false,pilot_slot_held:true},integrity:{purchase_matches:true,pix_matches:true,converted_amount_matches:true,approval_matches:true,execution_matches:true},onchain_delivery_verified:false,mainnet_execution:false,fee_breakdown:null});
  expect(f.sends()).toBe(1);
  expect(JSON.stringify(complete)).not.toContain("PRIVATE_SYNTHETIC");
 });
 it("blocks audit without MFA or role and rejects customer-role overlap",async()=>{
  const f=await approvalFixture(),audit=new OperatorWithdrawalAuditService(pool,new Set([f.user.id,f.s.owner]));
  for(const [identity,code] of [[{id:f.user.id},"WITHDRAWAL_OPERATOR_MFA_REQUIRED"],[{id:randomUUID(),assuranceLevel:"aal2"},"WITHDRAWAL_OPERATOR_REQUIRED"],[{id:f.s.owner,assuranceLevel:"aal2"},"OPERATOR_ACCOUNT_SEPARATION_REQUIRED"]] as const){
   const app=await buildApp({customerAccess:{customers,authenticate:async()=>identity},operatorWithdrawalAuditService:audit});apps.push(app);
   const response=await app.inject({method:"GET",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/audit`,headers:{authorization:"Bearer valid"}});
   expect(response.statusCode).toBe(403);expect(response.json().error.code).toBe(code);
  }
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>{throw new AuthenticationError("INVALID_TOKEN");}},operatorWithdrawalAuditService:audit});apps.push(app);
  expect((await app.inject({method:"GET",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/audit`})).statusCode).toBe(401);
 });
 it("reports historical binding mismatch and rejects unknown IDs, selectors and private DB errors",async()=>{
  const f=await approvalFixture(),audit=new OperatorWithdrawalAuditService(pool,new Set([f.user.id]));
  await db.query("update peragus_customer_purchase_intents set wallet_address=$1 where id=$2",[Keypair.generate().publicKey.toBase58(),f.p.data.id]);
  await db.query("update peragus_customers set suspended=true where id=$1",[f.s.customer.id]);
  expect((await audit.read(f.user,f.wr.data.id)).integrity.purchase_matches).toBe(false);
  await db.query("update peragus_customer_withdrawal_requests set amount_usdt='99999999999999.000001' where id=$1",[f.wr.data.id]);
  await db.query("update peragus_customer_sandbox_pix set observation=jsonb_set(observation,'{amounts,target,amount}','\"99999999999999.000002\"') where id=$1",[f.pixId]);
  expect((await audit.read(f.user,f.wr.data.id)).integrity.converted_amount_matches).toBe(false);
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>f.user},operatorWithdrawalAuditService:audit});apps.push(app);
  for(const [url,code] of [[`/v1/admin/withdrawal-requests/${randomUUID()}/audit`,404],["/v1/admin/withdrawal-requests/invalid/audit",400],[`/v1/admin/withdrawal-requests/${f.wr.data.id}/audit?refresh=true`,400]] as const){
   const response=await app.inject({method:"GET",url,headers:{authorization:"Bearer valid"}});
   expect(response.statusCode).toBe(code);expect(response.headers["cache-control"]).toBe("no-store");
  }
  const broken=new OperatorWithdrawalAuditService({query:async()=>{throw Error("PRIVATE_DATABASE_PASSWORD");}} as any,new Set([f.user.id]));
  const brokenApp=await buildApp({customerAccess:{customers,authenticate:async()=>f.user},operatorWithdrawalAuditService:broken});apps.push(brokenApp);
  const response=await brokenApp.inject({method:"GET",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/audit`,headers:{authorization:"Bearer valid"}});
  expect(response.statusCode).toBe(503);expect(response.body).not.toContain("PRIVATE_DATABASE_PASSWORD");
 });
 it("lists pending operator withdrawals with MFA while approval and sends stay disabled",async()=>{
  const f=await approvalFixture(),queue=new OperatorWithdrawalQueueService(pool,new Set([f.user.id]));
  const stats=f.stats(),app=await buildApp({customerAccess:{customers,authenticate:async token=>{
   if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return f.user;
  }},operatorWithdrawalQueueService:queue});apps.push(app);
  const response=await app.inject({method:"GET",url:"/v1/admin/withdrawal-requests",headers:{authorization:"Bearer valid"}});
  expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
  const item=response.json().data.find((r:any)=>r.id===f.wr.data.id);
  expect(item).toMatchObject({state:"pending_approval",approved:false,source:{currency:"USDT",amount:"200.000000"},execution_authorized:false,current_eligibility_evaluated:false,withdrawal_started:false,provider_completed:false});
  for(const secret of [f.s.provider,f.user.id,f.reason,"private@example.test","provider_customer_id","travel_rule",'"request_id"'])expect(response.body).not.toContain(secret);
  expect(f.stats()).toEqual(stats);
  expect((await app.inject({method:"GET",url:"/v1/admin/withdrawal-requests"})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/approval`,headers:{authorization:"Bearer valid"},payload:{request_id:randomUUID(),reason:f.reason}})).statusCode).toBe(503);
  expect((await app.inject({method:"POST",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/execution`,headers:{authorization:"Bearer valid"},payload:{request_id:randomUUID(),confirmation:"SANDBOX_ONLY"}})).statusCode).toBe(503);
 });
 it("blocks operator queue without MFA, revoked roles and customer-role overlap",async()=>{
  const f=await approvalFixture(),queue=new OperatorWithdrawalQueueService(pool,new Set([f.user.id,f.s.owner]));
  for(const [identity,code] of [[{id:f.user.id},"WITHDRAWAL_OPERATOR_MFA_REQUIRED"],[{id:randomUUID(),assuranceLevel:"aal2"},"WITHDRAWAL_OPERATOR_REQUIRED"],[{id:f.s.owner,assuranceLevel:"aal2"},"OPERATOR_ACCOUNT_SEPARATION_REQUIRED"]] as const){
   const app=await buildApp({customerAccess:{customers,authenticate:async()=>identity},operatorWithdrawalQueueService:queue});apps.push(app);
   const response=await app.inject({method:"GET",url:"/v1/admin/withdrawal-requests",headers:{authorization:"Bearer valid"}});
   expect(response.statusCode).toBe(403);expect(response.json().error.code).toBe(code);
  }
 });
 it("filters uncertain, completed and review records without another provider call",async()=>{
  const f=await executionFixture(),queue=new OperatorWithdrawalQueueService(pool,new Set([f.user.id]));
  const own=async(state:string)=>(await queue.list(f.user,{state})).data.find(r=>r.id===f.wr.data.id);
  expect(await own("approved")).toMatchObject({state:"approved"});
  f.setMode("timeout");await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  expect(await own("uncertain")).toMatchObject({recovery_required:true,provider_completed:false});
  f.setFound(f.sendId);await f.execution.reconcile(f.user,f.wr.data.id);
  expect(await own("completed")).toMatchObject({state:"completed",provider_completed:true,execution_authorized:false,onchain_delivery_verified:false});
  expect(await own("uncertain")).toBeUndefined();expect(f.sends()).toBe(1);
  await db.query("update peragus_sandbox_withdrawal_executions set observation=jsonb_set(observation,'{destinationLegStatus}','\"pending\"') where withdrawal_request_id=$1",[f.wr.data.id]);
  expect(await own("needs_review")).toMatchObject({manual_review_required:true,provider_completed:false});
 });
 it("paginates operator queue ties and rejects selectors and private DB errors",async()=>{
  const f=await approvalFixture(),other=await approvalFixture(),queue=new OperatorWithdrawalQueueService(pool,new Set([f.user.id]));
  for(const id of [f.wr.data.id,other.wr.data.id])await db.query("update peragus_customer_withdrawal_requests set created_at='2200-01-01T00:00:00.123456Z' where id=$1",[id]);
  const expected=[f.wr.data.id,other.wr.data.id].sort().reverse();
  const first=await queue.list(f.user,{state:"all",limit:"1"});
  const second=await queue.list(f.user,{state:"all",limit:"1",cursor:first.meta.next_cursor!});
  expect([first.data[0]!.id,second.data[0]!.id]).toEqual(expected);
  expect(first.data[0]!.created_at).toBe("2200-01-01T00:00:00.123456Z");
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>f.user},operatorWithdrawalQueueService:queue});apps.push(app);
  for(const query of ["state=unknown","limit=51","cursor=invalid","customer_id="+f.s.customer.id]){
   const response=await app.inject({method:"GET",url:"/v1/admin/withdrawal-requests?"+query,headers:{authorization:"Bearer valid"}});
   expect(response.statusCode).toBe(400);expect(response.headers["cache-control"]).toBe("no-store");
  }
  const broken=new OperatorWithdrawalQueueService({query:async()=>{throw Error("PRIVATE_DATABASE_PASSWORD");}} as any,new Set([f.user.id]));
  const brokenApp=await buildApp({customerAccess:{customers,authenticate:async()=>f.user},operatorWithdrawalQueueService:broken});apps.push(brokenApp);
  const failure=await brokenApp.inject({method:"GET",url:"/v1/admin/withdrawal-requests",headers:{authorization:"Bearer valid"}});
  expect(failure.statusCode).toBe(503);expect(failure.body).not.toContain("PRIVATE_DATABASE_PASSWORD");
 });
 it("lists only owned operations with write gates off and no provider refresh",async()=>{
  const f=await executionFixture(),other=await executionFixture();
  const history=new CustomerOperationHistoryService(pool),stats=f.stats(),reads=f.identityReads();
  const app=await buildApp({customerAccess:{customers,authenticate:async token=>{
   if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");
   return{id:f.s.owner,email:"synthetic@example.test"};
  }},customerOperationHistoryService:history});apps.push(app);
  const response=await app.inject({method:"GET",url:"/v1/me/operations",headers:{authorization:"Bearer valid"}});
  expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
  const body=response.json();expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({id:f.p.data.id,stage:"withdrawal",source:{currency:"BRL",amount:"1000.00"},converted_target:{currency:"USDT",amount:"200.000000"},withdrawal:{id:f.wr.data.id,state:"approved",provider_completed:false},real_money:false,onchain_delivery_verified:false});
  expect(body.meta).toEqual({has_more:false,next_cursor:null});
  for(const secret of [other.p.data.id,f.user.id,f.s.provider,"PRIVATE_SYNTHETIC","travel_rule",'"request_id"',"provider_customer_id"])expect(response.body).not.toContain(secret);
  expect(f.stats()).toEqual(stats);expect(f.identityReads()).toBe(reads);expect(f.sends()).toBe(0);
  expect((await app.inject({method:"GET",url:"/v1/me/operations"})).statusCode).toBe(401);
  for(const query of ["limit=0","limit=51","limit=1&limit=2","customer_id="+other.s.customer.id,"cursor=%%%","cursor="+Buffer.from("{}").toString("base64url")]){
   const r=await app.inject({method:"GET",url:"/v1/me/operations?"+query,headers:{authorization:"Bearer valid"}});
   expect(r.statusCode).toBe(400);
  }
  expect((await app.inject({method:"POST",url:"/v1/me/withdrawal-requests",headers:{authorization:"Bearer valid"},payload:{}})).statusCode).toBe(503);
 });
 it("paginates microsecond timestamps and UUID ties without leaking across customers",async()=>{
  const s=await setup(),history=new CustomerOperationHistoryService(pool);
  const ids:string[]=[];
  ids.push((await service.record(s.customer.id,randomUUID(),s.quoteId)).data.id);
  for(let i=0;i<2;i++)ids.push((await service.record(s.customer.id,randomUUID(),await s.makeQuote())).data.id);
  await db.query("update peragus_customer_purchase_intents set created_at='2026-10-20T12:00:00.123456Z' where customer_id=$1",[s.customer.id]);
  const expected=[...ids].sort().reverse();
  const first=await history.list(s.customer.id,parseHistoryQuery({limit:"1"}));
  expect(first.data.map(r=>r.id)).toEqual(expected.slice(0,1));
  expect(first.data[0]).toMatchObject({stage:"purchase_recorded",pix:null,withdrawal:null,converted_target:null});
  expect(first.data[0]!.created_at).toBe("2026-10-20T12:00:00.123456Z");
  const inserted=(await service.record(s.customer.id,randomUUID(),await s.makeQuote())).data.id;
  await db.query("update peragus_customer_purchase_intents set created_at='2026-10-20T12:00:00.123457Z' where id=$1",[inserted]);
  const second=await history.list(s.customer.id,parseHistoryQuery({limit:"1",cursor:first.meta.next_cursor!}));
  const third=await history.list(s.customer.id,parseHistoryQuery({limit:"1",cursor:second.meta.next_cursor!}));
  expect([...first.data,...second.data,...third.data].map(r=>r.id)).toEqual(expected);
  expect(third.meta).toEqual({has_more:false,next_cursor:null});
  const foreign=await setup();
  expect(await history.list(foreign.customer.id,parseHistoryQuery({cursor:first.meta.next_cursor!}))).toEqual({data:[],meta:{has_more:false,next_cursor:null}});
 });
 it("keeps uncertain and completed custody states distinct from real delivery",async()=>{
  const f=await executionFixture(),history=new CustomerOperationHistoryService(pool);
  f.setMode("timeout");await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  const uncertain=await history.list(f.s.customer.id,parseHistoryQuery({}));
  expect(uncertain.data[0]!.withdrawal).toMatchObject({state:"uncertain",recovery_required:true,provider_completed:false});
  f.setFound(f.sendId);f.provider.transfer=async()=>({...f.observed,targetAmount:null});
  await f.execution.reconcile(f.user,f.wr.data.id);
  const completed=await history.list(f.s.customer.id,parseHistoryQuery({}));
  expect(completed.data[0]).toMatchObject({withdrawal:{state:"provider_completed",provider_completed:true,recovery_required:false,result_path:`/v1/me/withdrawal-requests/${f.wr.data.id}/result`},onchain_delivery_verified:false,mainnet_execution:false});
  expect(f.sends()).toBe(1);
 });
 it("hides partial conversion amounts and database error details",async()=>{
  const f=await completedFixture(),history=new CustomerOperationHistoryService(pool);
  await db.query("update peragus_customer_sandbox_pix set observation=jsonb_set(observation,'{destinationLegStatus}','\"pending\"') where id=$1",[f.pixId]);
  expect((await history.list(f.s.customer.id,parseHistoryQuery({}))).data[0]).toMatchObject({stage:"pix",converted_target:null,pix:{conversion_completed:false}});
  const broken=new CustomerOperationHistoryService({query:async()=>{throw Error("PRIVATE_DATABASE_PASSWORD");}} as any);
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:f.s.owner})},customerOperationHistoryService:broken});apps.push(app);
  const response=await app.inject({method:"GET",url:"/v1/me/operations",headers:{authorization:"Bearer valid"}});
  expect(response.statusCode).toBe(503);expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).not.toContain("PRIVATE_DATABASE_PASSWORD");
 });
 it("serves owned stored results while all write services are disabled",async()=>{
  const f=await executionFixture();await f.execution.execute(f.user,f.wr.data.id,f.executionRequestId);
  const reads=new CustomerWithdrawalResultService(pool);
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:f.s.owner,email:"synthetic@example.test"})},customerWithdrawalResultService:reads});
  apps.push(app);
  const path=`/v1/me/withdrawal-requests/${f.wr.data.id}/result`;
  const response=await app.inject({method:"GET",url:path,headers:{authorization:"Bearer valid"}});
  expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json().data).toMatchObject({state:"provider_completed",provider_completed:true,amounts:{gross_amount:"200.000000",net_amount:"199.500000",deducted_amount:"0.500000",fee_breakdown:null},onchain_delivery_verified:false});
  const text=response.body;
  for(const secret of [f.user.id,f.sendId,"PRIVATE_SYNTHETIC","operator_id","travel_rule",'"request_id"'])expect(text).not.toContain(secret);
  expect(f.sends()).toBe(1);
  expect((await app.inject({method:"POST",url:"/v1/me/withdrawal-requests",headers:{authorization:"Bearer valid"},payload:{}})).statusCode).toBe(503);
  expect((await app.inject({method:"GET",url:path+"?refresh=true",headers:{authorization:"Bearer valid"}})).statusCode).toBe(400);
  expect((await app.inject({method:"GET",url:path})).statusCode).toBe(401);
  expect((await app.inject({method:"GET",url:`/v1/me/withdrawal-requests/${randomUUID()}/result`,headers:{authorization:"Bearer valid"}})).statusCode).toBe(404);
  const other=await executionFixture();
  await expect(reads.read(other.s.customer.id,f.wr.data.id)).rejects.toThrow("WITHDRAWAL_REQUEST_NOT_FOUND");
 });
 it("preserves unknown amounts through approval, uncertainty and omitted target completion",async()=>{
  const f=await executionFixture(),reads=new CustomerWithdrawalResultService(pool);
  expect(await reads.read(f.s.customer.id,f.wr.data.id)).toMatchObject({state:"approved",provider_completed:false,amounts:{net_amount:null,deducted_amount:null,basis:"not_reported"}});
  f.setMode("timeout");await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  expect(await reads.read(f.s.customer.id,f.wr.data.id)).toMatchObject({state:"uncertain",recovery_required:true});
  f.setFound(f.sendId);f.provider.transfer=async()=>({...f.observed,targetAmount:null});
  await f.execution.reconcile(f.user,f.wr.data.id);
  expect(await reads.read(f.s.customer.id,f.wr.data.id)).toMatchObject({state:"provider_completed",provider_completed:true,recovery_required:false,amounts:{net_amount:null,deducted_amount:null,basis:"not_reported"}});
  expect(f.sends()).toBe(1);
 });
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
 it("recovers missing target evidence without inventing net delivery or repeating send",async()=>{
  const f=await executionFixture();f.setMode("timeout");
  await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  f.setFound(f.sendId);f.provider.transfer=async()=>({...f.observed,targetAmount:null});
  const recovered=await f.execution.reconcile(f.user,f.wr.data.id);
  expect(recovered.provider_completed).toBe(true);expect(recovered.provider_target_amount).toBeNull();
  expect(recovered.onchain_delivery_verified).toBe(false);expect(recovered.recovery_required).toBe(false);
  expect((await f.execution.read(f.user,f.wr.data.id)).provider_target_amount).toBeNull();
  expect(f.sends()).toBe(1);
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


describe("owned operation detail",()=>{
 it("reads an old operation directly with write services absent and preserves the history projection",async()=>{
  const f=await completedFixture(),history=new CustomerOperationHistoryService(pool);
  await db.query("update peragus_customer_purchase_intents set created_at=now()-interval '4 years' where id=$1",[f.p.data.id]);
  await service.record(f.s.customer.id,randomUUID(),await f.s.makeQuote());
  const recent=await history.list(f.s.customer.id,parseHistoryQuery({limit:"1"}));
  expect(recent.data.map(row=>row.id)).not.toContain(f.p.data.id);
  const stats=f.stats();
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:f.s.owner})},customerOperationHistoryService:history});apps.push(app);
  const response=await app.inject({method:"GET",url:`/v1/me/operations/${f.p.data.id}`,headers});
  expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
  const listed=(await history.list(f.s.customer.id,parseHistoryQuery({}))).data.find(row=>row.id===f.p.data.id);
  expect(response.json()).toEqual({data:listed});
  expect(response.json().data).toMatchObject({source:{currency:"BRL",amount:"1000.00"},converted_target:{currency:"USDT",amount:"200.000000"},environment:"test",real_money:false,onchain_delivery_verified:false,mainnet_execution:false});
  for(const secret of [f.s.provider,"private proof message","private proof signature","private_data","encrypted_payload"])
   expect(response.body).not.toContain(secret);
  expect(f.stats()).toEqual(stats);
 });
 it("uses identical 404s for foreign and missing records and rejects selectors and invalid IDs",async()=>{
  const f=await completedFixture(),other=await setup(),history=new CustomerOperationHistoryService(pool);
  const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:other.owner})},customerOperationHistoryService:history});apps.push(app);
  const foreign=await app.inject({method:"GET",url:`/v1/me/operations/${f.p.data.id}`,headers});
  const missing=await app.inject({method:"GET",url:`/v1/me/operations/${randomUUID()}`,headers});
  expect(foreign.statusCode).toBe(404);expect(foreign.json()).toEqual({error:{code:"OPERATION_NOT_FOUND"}});
  expect(missing.statusCode).toBe(404);expect(missing.json()).toEqual(foreign.json());
  expect(foreign.headers["cache-control"]).toBe("no-store");
  for(const suffix of ["?customer_id="+f.s.customer.id,"?limit=1","?cursor=anything","?state=all"]){
   const invalid=await app.inject({method:"GET",url:`/v1/me/operations/${f.p.data.id}${suffix}`,headers});
   expect(invalid.statusCode).toBe(400);expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
  }
  expect((await app.inject({method:"GET",url:"/v1/me/operations/not-a-uuid",headers})).statusCode).toBe(400);
  expect((await app.inject({method:"GET",url:`/v1/me/operations/${f.p.data.id}`})).statusCode).toBe(401);
 });
 it("rejects PJ and suspended profiles and hides private repository errors",async()=>{
  const pj=await setup("pj"),f=await completedFixture(),history=new CustomerOperationHistoryService(pool);
  const appFor=async(owner:string,reader=history)=>{
   const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:owner})},customerOperationHistoryService:reader});apps.push(app);return app;
  };
  const url=`/v1/me/operations/${f.p.data.id}`;
  expect((await (await appFor(pj.owner)).inject({method:"GET",url,headers})).statusCode).toBe(403);
  const broken=new CustomerOperationHistoryService({query:async()=>{throw Error("PRIVATE_DATABASE_PASSWORD");}} as any);
  const error=await (await appFor(f.s.owner,broken)).inject({method:"GET",url,headers});
  expect(error.statusCode).toBe(503);expect(error.json().error.code).toBe("OPERATION_HISTORY_UNAVAILABLE");expect(error.body).not.toContain("PRIVATE_DATABASE_PASSWORD");
  await db.query("update peragus_customers set suspended=true where id=$1",[f.s.customer.id]);
  expect((await (await appFor(f.s.owner)).inject({method:"GET",url,headers})).statusCode).toBe(403);
 });
});

import {OperatorAlertService} from "../src/operations/operator-alerts.js";
import {ManualRefundService} from "../src/refunds/manual-refunds.js";
describe("stored operational alerts",()=>{
 beforeEach(async()=>{await db.exec("truncate peragus_customer_reconciliation,peragus_customer_refund_requests cascade");});
 async function alertApp(f:Awaited<ReturnType<typeof approvalFixture>>,identity:any=f.user,reader=new OperatorAlertService(pool,new Set([f.user.id]))){
  const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return identity;}},operatorAlertService:reader});apps.push(app);return app;
 }
 it("keeps pending and approved refunds actionable without recording a return",async()=>{
  const f=await approvalFixture(),refunds=new ManualRefundService(pool,new Set([f.user.id]),true);
  const requested=await refunds.request(f.s.customer.id,f.p.data.id,randomUUID(),"Synthetic refund for manual review only.");
  const app=await alertApp(f),url="/v1/admin/operational-alerts";
  const pending=await app.inject({url,headers});expect(pending.statusCode).toBe(200);
  expect(pending.json().data).toEqual([expect.objectContaining({kind:"refund_pending_review",refund_request_id:requested.data.id,severity:"medium"})]);
  await refunds.decide(f.user,requested.data.id,randomUUID(),"approved","Synthetic manual review, no external return.");
  const before=await db.query("select * from peragus_customer_refund_requests where id=$1",[requested.data.id]);
  const result=await app.inject({url,headers});expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.json().data).toEqual([expect.objectContaining({kind:"refund_approved",execution_authorized:false,detail_path:`/v1/admin/refund-requests/${requested.data.id}`})]);
  expect(result.json().meta).toMatchObject({provider_refreshed:false,notifications_sent:false});
  expect(result.body).not.toMatch(/Synthetic|private|ozav_|wallet_address|operator_user_id|cpf/);
  expect((await db.query("select * from peragus_customer_refund_requests where id=$1",[requested.data.id])).rows).toEqual(before.rows);
  expect((await db.query("select * from peragus_manual_refund_completions")).rows).toHaveLength(0);
 });
 it("does not list rejected or externally recorded refund cases",async()=>{
  const f=await approvalFixture(),refunds=new ManualRefundService(pool,new Set([f.user.id]),true);
  const r=await refunds.request(f.s.customer.id,f.p.data.id,randomUUID(),"Synthetic request with rejected decision.");
  await refunds.decide(f.user,r.data.id,randomUUID(),"rejected","Synthetic rejected manual review reason.");
  expect((await new OperatorAlertService(pool,new Set([f.user.id])).list(f.user,{})).data).toHaveLength(0);
  // Positive completion belongs only to this isolated database, not staging.
  const other=await approvalFixture(),service=new ManualRefundService(pool,new Set([other.user.id]),true);
  const next=await service.request(other.s.customer.id,other.p.data.id,randomUUID(),"Synthetic request with isolated completion.");
  await service.decide(other.user,next.data.id,randomUUID(),"approved","Synthetic isolated manual review approval.");
  await service.complete(other.user,next.data.id,randomUUID(),"1000.00","synthetic-external-reference");
  expect((await new OperatorAlertService(pool,new Set([other.user.id])).list(other.user,{})).data).toHaveLength(0);
 });
 it("surfaces uncertain withdrawals and clears them after GET-only recovery without another send",async()=>{
  const f=await executionFixture();f.setMode("timeout");await expect(f.execution.execute(f.user,f.wr.data.id,f.executionRequestId)).rejects.toThrow();
  const alerts=new OperatorAlertService(pool,new Set([f.user.id]));
  expect((await alerts.list(f.user,{})).data).toEqual([expect.objectContaining({kind:"withdrawal_uncertain",severity:"high"})]);
  const sends=f.sends();f.setFound(f.sendId);
  await new SandboxWithdrawalRecoveryService(f.repo,{find:f.provider.find,transfer:f.provider.transfer},new Set([f.user.id])).reconcile(f.user,f.wr.data.id);
  expect((await alerts.list(f.user,{})).data).toHaveLength(0);expect(f.sends()).toBe(sends);
  expect((await db.query("select closed_at from peragus_sandbox_withdrawal_executions")).rows[0]).toEqual({closed_at:null});
 });
 it("flags failed and partially completed withdrawal evidence for manual review",async()=>{
  const f=await executionFixture();await f.execution.execute(f.user,f.wr.data.id,f.executionRequestId);
  const alerts=new OperatorAlertService(pool,new Set([f.user.id]));
  for(const observation of [{...f.observed,status:'failed'},{...f.observed,destinationLegStatus:'pending'}]){
   await db.query('update peragus_sandbox_withdrawal_executions set observation=$1 where withdrawal_request_id=$2',[observation,f.wr.data.id]);
   expect((await alerts.list(f.user,{})).data).toEqual([expect.objectContaining({kind:'withdrawal_review',severity:'high'})]);
  }
  expect(f.sends()).toBe(1);
 });
 it("surfaces review and stalled checkpoints but excludes healthy terminal records and active leases",async()=>{
  const f=await approvalFixture(),id=randomUUID();
  await db.query(`insert into peragus_customer_reconciliation(id,customer_id,purchase_intent_id,pix_id,state,manual_review_required)
   values($1,$2,$3,$4,'needs_review',true)`,[id,f.s.customer.id,f.p.data.id,f.pixId]);
  const alerts=new OperatorAlertService(pool,new Set([f.user.id]));
  expect((await alerts.list(f.user,{})).data[0]).toMatchObject({kind:"reconciliation_review"});
  await db.query("update peragus_customer_reconciliation set state='pending',manual_review_required=false,next_check_at=now()-interval '16 minutes' where id=$1",[id]);
  expect((await alerts.list(f.user,{})).data[0]).toMatchObject({kind:"reconciliation_stalled"});
  await db.query("update peragus_customer_reconciliation set lease_token=$2,lease_until=now()+interval '1 minute' where id=$1",[id,randomUUID()]);
  expect((await alerts.list(f.user,{})).data).toHaveLength(0);
  await db.query("update peragus_customer_reconciliation set state='provider_terminal',lease_token=null,lease_until=null where id=$1",[id]);
  expect((await alerts.list(f.user,{})).data).toHaveLength(0);
 });
 it("paginates tied alerts without duplicates and applies severity/kind filters",async()=>{
  const f=await approvalFixture(),refunds=new ManualRefundService(pool,new Set([f.user.id]),true);
  await refunds.request(f.s.customer.id,f.p.data.id,randomUUID(),"Synthetic refund for pagination checking.");
  await db.query(`insert into peragus_customer_reconciliation(customer_id,purchase_intent_id,pix_id,state,manual_review_required,created_at)
    values($1,$2,$3,'needs_review',true,'2026-01-01T00:00:00.123456Z')`,[f.s.customer.id,f.p.data.id,f.pixId]);
  await db.query(`insert into peragus_customer_reconciliation(customer_id,purchase_intent_id,withdrawal_request_id,state,manual_review_required,created_at)
    values($1,$2,$3,'needs_review',true,'2026-01-01T00:00:00.123456Z')`,[f.s.customer.id,f.p.data.id,f.wr.data.id]);
  const alerts=new OperatorAlertService(pool,new Set([f.user.id]));let cursor:string|undefined;const ids:string[]=[];
  for(let i=0;i<3;i++){
   const page=await alerts.list(f.user,{limit:'1',...(cursor?{cursor}:{})});ids.push(page.data[0]!.id);cursor=page.meta.next_cursor??undefined;
  }
  expect(new Set(ids).size).toBe(3);expect(cursor).toBeUndefined();
  expect((await alerts.list(f.user,{severity:'high'})).data).toHaveLength(2);
  expect((await alerts.list(f.user,{kind:'refund_pending_review'})).data).toHaveLength(1);
 });
 it("requires MFA, operator role and account separation and sanitizes database failures",async()=>{
  const f=await approvalFixture(),url='/v1/admin/operational-alerts';
  const app=await alertApp(f);expect((await app.inject({url})).statusCode).toBe(401);
  const noMfa=await alertApp(f,{id:f.user.id});
  expect((await noMfa.inject({url,headers})).json().error.code).toBe('WITHDRAWAL_OPERATOR_MFA_REQUIRED');
  const foreign=await alertApp(f,{id:randomUUID(),assuranceLevel:'aal2'});
  expect((await foreign.inject({url,headers})).statusCode).toBe(403);
  const customer=await alertApp(f,{id:f.s.owner,assuranceLevel:'aal2'},new OperatorAlertService(pool,new Set([f.s.owner])));
  expect((await customer.inject({url,headers})).json().error.code).toBe('OPERATOR_ACCOUNT_SEPARATION_REQUIRED');
  expect((await app.inject({url:url+'?customer_id='+f.s.customer.id,headers})).statusCode).toBe(400);
  const broken=await alertApp(f,f.user,new OperatorAlertService({query:async()=>{throw Error('PRIVATE_DATABASE_PASSWORD');}} as any,new Set([f.user.id])));
  const failed=await broken.inject({url,headers});expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('PRIVATE_DATABASE_PASSWORD');
 });
});
