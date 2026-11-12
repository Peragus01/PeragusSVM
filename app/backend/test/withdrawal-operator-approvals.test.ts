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
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),"utf8"));
 await db.exec("insert into peragus_database_environment(environment) values('test')");
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
 const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return{id:s.owner,email:"private@example.test"};}},...(enabled?{customerPurchaseIntentService:service}:{})});apps.push(app);return app;
}
const path="/v1/me/purchase-intents",headers={authorization:"Bearer valid"};

import {PostgresCustomerPixRepository} from "../src/repositories/postgres-customer-sandbox-pix.js";
import {CustomerSandboxPixService} from "../src/purchases/customer-sandbox-pix.js";
import type {OzavTransfer} from "../src/providers/ozav-client.js";
async function fixture(){
 const s=await setup();
 await db.query("update peragus_customer_indicative_quotes set source_amount_brl=1000,observation=jsonb_set(observation,'{source,amount}','\"1000.00\"') where id=$1",[s.quoteId]);
 const p=await service.record(s.customer.id,s.requestId,s.quoteId),pixRepo=new PostgresCustomerPixRepository(pool,"test");
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
const withdrawalRepo=new PostgresCustomerWithdrawalRequestRepository(pool,"test"),withdrawals=new CustomerWithdrawalRequestService(withdrawalRepo);
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
const approvalRepo=new PostgresWithdrawalOperatorApprovalRepository(pool,"test");
const nowSeconds=()=>Math.floor(Date.now()/1000);
// The progression moves a converted operation to awaiting_approval; fixtures replay those moves.
async function awaitingApproval(purchaseId:string){for(const to of ["awaiting_pix","converted","awaiting_approval"] as const)await repo.transitionOperation(purchaseId,to,"system:test","test_fixture");}
async function approvalFixture(ready=true){
 const f=await completedFixture(),wr=await withdrawals.record(f.s.customer.id,f.withdrawalRequestId,f.pixId),operatorId=randomUUID(),user={id:operatorId,email:"operator@example.test",assuranceLevel:"aal2" as const,mfaVerifiedAt:nowSeconds()};
 if(ready)await awaitingApproval(f.p.data.id);
 const approvals=new WithdrawalOperatorApprovalService(approvalRepo,new Set([operatorId]));
 return{...f,wr,user,approvals,approvalRequestId:randomUUID(),reason:"Reviewed the completed sandbox conversion and verified destination."};
}
async function approvalApp(f:Awaited<ReturnType<typeof approvalFixture>>,identity=f.user,enabled=true){
 const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return identity;}},...(enabled?{withdrawalOperatorApprovalService:f.approvals}:{})});apps.push(app);return app;
}
describe("withdrawal operator approval audit",()=>{
 it("records an allowlisted MFA operator decision without any send and exposes safe approval state to its owner",async()=>{
  const f=await approvalFixture(),before=f.stats(),r=await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
  expect(r.replayed).toBe(false);expect(r.data).toMatchObject({approved:true,environment:"test",record_only:true,execution_authorized:false,source:{amount:"200.000000"},withdrawal_started:false,job_enqueued:false,operator_user_id:f.user.id,reason:f.reason});
  const customerView=await withdrawals.read(f.s.customer.id,f.wr.data.id);expect(customerView.approved).toBe(true);expect(customerView.approval_recorded_at).toBe(r.data.created_at);expect(customerView.withdrawal_started).toBe(false);expect(JSON.stringify(customerView)).not.toContain(f.reason);expect(JSON.stringify(customerView)).not.toContain(f.user.id);
  expect(f.stats()).toEqual(before);expect((await db.query("select count(*) as n from settlements")).rows[0]).toEqual({n:0});
 });
 it("replays the same operator request, rejects changed reasons and never overwrites a prior decision",async()=>{
  const f=await approvalFixture(),one=await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
  const again=await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);expect(again.replayed).toBe(true);expect(again.data).toEqual(one.data);
  await expect(f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,"A different reason for the decision")).rejects.toThrow("WITHDRAWAL_APPROVAL_IDEMPOTENCY_CONFLICT");
  await expect(f.approvals.approve(f.user,f.wr.data.id,randomUUID(),f.reason)).rejects.toThrow("WITHDRAWAL_APPROVAL_ALREADY_RECORDED");
 });
 it("permits only one decision under concurrent requests",async()=>{
  const f=await approvalFixture(),results=await Promise.allSettled([f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason),f.approvals.approve(f.user,f.wr.data.id,randomUUID(),f.reason)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 });
 it("rejects missing MFA, non-allowlisted users and malformed operator lists",async()=>{
  const f=await approvalFixture();await expect(f.approvals.approve({...f.user,assuranceLevel:undefined},f.wr.data.id,f.approvalRequestId,f.reason)).rejects.toThrow("WITHDRAWAL_OPERATOR_MFA_REQUIRED");
  await expect(f.approvals.approve({...f.user,id:randomUUID()},f.wr.data.id,f.approvalRequestId,f.reason)).rejects.toThrow("WITHDRAWAL_OPERATOR_REQUIRED");
  expect(()=>parseWithdrawalOperators("not-a-user-id")).toThrow();expect(parseWithdrawalOperators(` ${f.user.id}, `)).toEqual([f.user.id]);
 });
 it("rechecks conversion, current identity and wallet evidence at approval",async()=>{
  for(const sql of ["update peragus_customer_verifications set observation='{}' where customer_id=$1","update peragus_customer_screenings set observation='{}' where customer_id=$1","update peragus_customers set suspended=true where id=$1","delete from peragus_customer_wallets where customer_id=$1"]){
   const f=await approvalFixture();await db.query(sql,[f.s.customer.id]);await expect(f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason)).rejects.toThrow("WITHDRAWAL_APPROVAL_PREREQUISITES_REQUIRED");
  }
 });
 it("rejects customer accounts as operators even if mistakenly allowlisted",async()=>{
  const f=await approvalFixture(),customerOperator={...f.user,id:f.s.owner},service=new WithdrawalOperatorApprovalService(approvalRepo,new Set([customerOperator.id]));
  await expect(service.approve(customerOperator,f.wr.data.id,f.approvalRequestId,f.reason)).rejects.toThrow("WITHDRAWAL_APPROVAL_PREREQUISITES_REQUIRED");
  const app=await approvalApp(f,customerOperator);expect((await app.inject({method:"GET",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/approval`,headers})).statusCode).toBe(403);
 });
 it("gates admin routes by auth, feature, allowlist and MFA and requires strict reason/request input",async()=>{
  const f=await approvalFixture(),url=`/v1/admin/withdrawal-requests/${f.wr.data.id}/approval`,app=await approvalApp(f),payload={request_id:f.approvalRequestId,reason:f.reason};
  expect((await app.inject({method:"POST",url,payload})).statusCode).toBe(401);
  expect((await(await approvalApp(f,f.user,false)).inject({method:"POST",url,headers,payload})).statusCode).toBe(503);
  expect((await(await approvalApp(f,{...f.user,assuranceLevel:undefined} as any)).inject({method:"POST",url,headers,payload})).statusCode).toBe(403);
  expect((await(await approvalApp(f,{...f.user,id:randomUUID()})).inject({method:"GET",url,headers})).statusCode).toBe(403);
  for(const bad of [{...payload,reason:"short"},{...payload,reason:"a sufficiently long\\nreason",amount:"1"},{...payload,approved:true},{...payload,operator_user_id:f.user.id}])expect((await app.inject({method:"POST",url,headers,payload:bad})).statusCode).toBe(400);
  const result=await app.inject({method:"POST",url,headers,payload});expect(result.statusCode).toBe(201);expect(result.headers["cache-control"]).toBe("no-store");
  const read=await app.inject({method:"GET",url,headers});expect(read.statusCode).toBe(200);expect(read.json().data.id).toBe(result.json().data.id);
 });
 it("keeps browser roles unprivileged and records test/MFA evidence",async()=>{
  const f=await approvalFixture(),one=await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
  for(const assignment of ["environment='live'","assurance_level='aal1'","reason='short'"])await expect(db.query(`update peragus_withdrawal_operator_approvals set ${assignment} where id=$1`,[one.data.id])).rejects.toThrow();
  await expect(db.query("delete from peragus_withdrawal_operator_approvals where id=$1",[one.data.id])).rejects.toThrow("append-only");
  const r=await db.query("select relrowsecurity,has_table_privilege('anon','peragus_withdrawal_operator_approvals','SELECT') as anon_select,has_table_privilege('authenticated','peragus_withdrawal_operator_approvals','INSERT') as auth_insert from pg_class where relname='peragus_withdrawal_operator_approvals'");expect(r.rows[0]).toEqual({relrowsecurity:true,anon_select:false,auth_insert:false});
 });
});

import {requireFreshMfa,OperatorApprovalError} from "../src/withdrawals/operator-approvals.js";
import {ManualRefundService} from "../src/refunds/manual-refunds.js";
const statusOf=async(purchaseId:string)=>(await db.query<{status:string}>("select status from peragus_customer_purchase_intents where id=$1",[purchaseId])).rows[0]!.status;
describe("fresh operator MFA",()=>{
 const now=1_800_000_000,operator={id:randomUUID(),email:"operator@example.test",assuranceLevel:"aal2" as const};
 it("amr totp older than 300s is stale",()=>{
  expect(()=>requireFreshMfa({...operator,mfaVerifiedAt:now-301},300,now)).toThrow("OPERATOR_MFA_STALE");
 });
 it("amr without totp is stale",()=>{
  expect(()=>requireFreshMfa(operator,300,now)).toThrow(OperatorApprovalError);
  expect(()=>requireFreshMfa(operator,300,now)).toThrow("OPERATOR_MFA_STALE");
  expect(()=>requireFreshMfa({...operator,assuranceLevel:undefined,mfaVerifiedAt:now},300,now)).toThrow("OPERATOR_MFA_STALE");
 });
 it("fresh totp passes",()=>{
  expect(()=>requireFreshMfa({...operator,mfaVerifiedAt:now-300},300,now)).not.toThrow();
  expect(()=>requireFreshMfa({...operator,mfaVerifiedAt:now},300,now)).not.toThrow();
 });
 it("a totp timestamp more than 10 s in the future is not fresh",()=>{
  expect(()=>requireFreshMfa({...operator,mfaVerifiedAt:now+11},300,now)).toThrow("OPERATOR_MFA_STALE");
  expect(()=>requireFreshMfa({...operator,mfaVerifiedAt:now+10},300,now)).not.toThrow();
 });
 it("approval requires fresh MFA (403) and records nothing with a stale one",async()=>{
  const f=await approvalFixture(),stale={...f.user,mfaVerifiedAt:nowSeconds()-301};
  await expect(f.approvals.approve(stale,f.wr.data.id,f.approvalRequestId,f.reason)).rejects.toThrow("OPERATOR_MFA_STALE");
  const app=await approvalApp(f,stale),r=await app.inject({method:"POST",url:`/v1/admin/withdrawal-requests/${f.wr.data.id}/approval`,headers,payload:{request_id:f.approvalRequestId,reason:f.reason}});
  expect(r.statusCode).toBe(403);expect(r.json().error.code).toBe("OPERATOR_MFA_STALE");
  expect(await approvalRepo.read(f.wr.data.id)).toBeNull();expect(await statusOf(f.p.data.id)).toBe("awaiting_approval");
 });
});

describe("GET /v1/admin/operator-status",()=>{
 const url="/v1/admin/operator-status";
 const statusApp=async(identity:{id:string;assuranceLevel?:"aal2"},operators:string[])=>{
  const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return identity;}},operatorUserIds:new Set(operators)});apps.push(app);return app;
 };
 it("operator-status is false for a non-allowlisted user and reveals nothing else",async()=>{
  const operator=randomUUID(),app=await statusApp({id:randomUUID()},[operator]);
  const r=await app.inject({method:"GET",url,headers});
  expect(r.statusCode).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.json()).toEqual({data:{operator:false,mfa_enrolled_required:true}});
 });
 it("is true for an allowlisted user at AAL1 (before MFA), false for one with a customer profile, and requires authentication",async()=>{
  const operator=randomUUID();
  expect((await(await statusApp({id:operator},[operator])).inject({method:"GET",url,headers})).json()).toEqual({data:{operator:true,mfa_enrolled_required:true}});
  const s=await setup();
  const customerOperator=await(await statusApp({id:s.owner},[s.owner])).inject({method:"GET",url,headers});
  expect(customerOperator.statusCode).toBe(200);expect(customerOperator.json()).toEqual({data:{operator:false,mfa_enrolled_required:true}});
  const anonymous=await(await statusApp({id:operator},[operator])).inject({method:"GET",url});
  expect(anonymous.statusCode).toBe(401);
  expect((await(await statusApp({id:operator},[operator])).inject({method:"GET",url:`${url}?x=1`,headers})).statusCode).toBe(400);
 });
});

describe("withdrawal approval vs operator refund decision (ruling 23)",()=>{
 const refundReason="Operator decided to return the Pix payment.";
 const refundsFor=(f:Awaited<ReturnType<typeof approvalFixture>>)=>new ManualRefundService(pool,new Set([f.user.id]),true,"test",true);
 it("moves the operation awaiting_approval -> approved with an audited event in the same transaction",async()=>{
  const f=await approvalFixture();await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
  expect(await statusOf(f.p.data.id)).toBe("approved");
  const events=(await db.query<{from_status:string;to_status:string;actor:string;reason:string}>("select from_status,to_status,actor,reason from peragus_operation_status_events where purchase_id=$1 order by id",[f.p.data.id])).rows;
  expect(events.at(-1)).toEqual({from_status:"awaiting_approval",to_status:"approved",actor:`operator:${f.user.id}`,reason:`OPERATOR_WITHDRAWAL_APPROVAL: ${f.reason}`});
  // A replay changes nothing more.
  await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
  expect((await db.query("select count(*)::int n from peragus_operation_status_events where purchase_id=$1 and to_status='approved'",[f.p.data.id])).rows[0]).toEqual({n:1});
 });
 it("refuses approval unless the operation is awaiting_approval",async()=>{
  const f=await approvalFixture(false);
  await expect(f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason)).rejects.toThrow("WITHDRAWAL_OPERATION_NOT_AWAITING_APPROVAL");
  expect(await approvalRepo.read(f.wr.data.id)).toBeNull();expect(await statusOf(f.p.data.id)).toBe("accepted");
 });
 it("decide-refund-then-approve is refused",async()=>{
  const f=await approvalFixture();
  await refundsFor(f).operationDecision(f.user,f.p.data.id,randomUUID(),refundReason);
  expect(await statusOf(f.p.data.id)).toBe("refund_pending");
  await expect(f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason)).rejects.toThrow("WITHDRAWAL_REFUND_IN_PROGRESS");
  expect(await approvalRepo.read(f.wr.data.id)).toBeNull();expect(await statusOf(f.p.data.id)).toBe("refund_pending");
 });
 it("approve-then-decide-refund is refused with REFUND_WITHDRAWAL_IN_PROGRESS",async()=>{
  const f=await approvalFixture();await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
  await expect(refundsFor(f).operationDecision(f.user,f.p.data.id,randomUUID(),refundReason)).rejects.toThrow("REFUND_WITHDRAWAL_IN_PROGRESS");
  expect(await statusOf(f.p.data.id)).toBe("approved");
  expect((await db.query("select count(*)::int n from peragus_operator_refund_decisions where purchase_id=$1",[f.p.data.id])).rows[0]).toEqual({n:0});
 });
 it("refuses a refund decision even after the approved operation went to review",async()=>{
  const f=await approvalFixture();await f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason);
  await repo.transitionOperation(f.p.data.id,"needs_review","system:test","synthetic review after approval");
  await expect(refundsFor(f).operationDecision(f.user,f.p.data.id,randomUUID(),refundReason)).rejects.toThrow("REFUND_WITHDRAWAL_IN_PROGRESS");
  expect(await statusOf(f.p.data.id)).toBe("needs_review");
 });
 it("concurrent approve vs decide: exactly one wins and the state matches the winner",async()=>{
  for(let i=0;i<4;i++){
   const f=await approvalFixture(),refunds=refundsFor(f);
   // Alternate which call starts first.
   const approve=()=>f.approvals.approve(f.user,f.wr.data.id,f.approvalRequestId,f.reason),decide=()=>refunds.operationDecision(f.user,f.p.data.id,randomUUID(),refundReason);
   const results:Promise<unknown>[]=i%2?[decide(),approve()]:[approve(),decide()];
   expect((await Promise.allSettled(results)).filter(r=>r.status==="fulfilled")).toHaveLength(1);
   const approvals=(await db.query<{n:number}>("select count(*)::int n from peragus_withdrawal_operator_approvals where withdrawal_request_id=$1",[f.wr.data.id])).rows[0]!.n;
   const decisions=(await db.query<{n:number}>("select count(*)::int n from peragus_operator_refund_decisions where purchase_id=$1",[f.p.data.id])).rows[0]!.n;
   expect(approvals+decisions).toBe(1);
   expect(await statusOf(f.p.data.id)).toBe(approvals?"approved":"refund_pending");
  }
 },30_000); // four full fixtures
});
