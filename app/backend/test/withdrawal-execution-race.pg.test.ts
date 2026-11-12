// Ruling 23 / Review Focus 3 under REAL lock contention: a double or concurrent execute claims
// once and POSTs the send once; an execute racing an operator refund decision never yields both.
// PGlite has a single session, so the embedded tests can only serialize connections; this file
// runs against a real PostgreSQL (CI's postgres:17 service, TEST_INVITE_DATABASE_URL) and is
// skipped when that variable is not set. It creates and drops its own throwaway database.
import {randomBytes,randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {Keypair} from "@solana/web3.js";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresCustomerPurchaseIntentRepository} from "../src/repositories/postgres-customer-purchase-intents.js";
import {PostgresCustomerPixRepository} from "../src/repositories/postgres-customer-sandbox-pix.js";
import {PostgresCustomerWithdrawalRequestRepository} from "../src/repositories/postgres-customer-withdrawal-requests.js";
import {PostgresWithdrawalOperatorApprovalRepository} from "../src/repositories/postgres-withdrawal-operator-approvals.js";
import {CustomerPurchaseIntentService} from "../src/purchases/customer-purchase-intents.js";
import {CustomerSandboxPixService} from "../src/purchases/customer-sandbox-pix.js";
import {CustomerWithdrawalRequestService} from "../src/withdrawals/customer-withdrawal-requests.js";
import {WithdrawalOperatorApprovalService} from "../src/withdrawals/operator-approvals.js";
import {ManualRefundService} from "../src/refunds/manual-refunds.js";
import {PostgresSandboxExecutionRepository} from "../src/repositories/postgres-sandbox-withdrawal-execution.js";
import {SandboxWithdrawalExecutionService} from "../src/withdrawals/sandbox-execution.js";
import type {OzavTransfer} from "../src/providers/ozav-client.js";

const realUrl=process.env.TEST_INVITE_DATABASE_URL;
if(realUrl && !["localhost","127.0.0.1"].includes(new URL(realUrl).hostname))throw Error("DISPOSABLE_LOCAL_DATABASE_REQUIRED");

describe.skipIf(!realUrl)("ruling 23 on real PostgreSQL: concurrent withdrawal execution claims once and sends once",()=>{
 const dbName=`peragus_exec_race_${randomBytes(6).toString("hex")}`;
 let admin:Pool,pool:Pool;
 const q=(sql:string,args?:unknown[])=>pool.query(sql,args as unknown[]);
 beforeAll(async()=>{
  admin=new Pool({connectionString:realUrl,max:1});
  await admin.query(`create database ${dbName}`);
  const url=new URL(realUrl!);url.pathname=`/${dbName}`;
  pool=new Pool({connectionString:url.toString(),max:12});
  const dir=new URL("../migrations/",import.meta.url);
  for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await q(await readFile(new URL(f,dir),"utf8"));
  await q("insert into peragus_database_environment(environment) values('test')");
 },120000);
 afterAll(async()=>{
  await pool?.end();
  if(admin){try{await admin.query(`drop database if exists ${dbName} with (force)`);}finally{await admin.end();}}
 });

 async function fixture(){
  // One unresolved execution may exist at a time (pilot slot): each race starts from an empty table.
  await q("truncate peragus_sandbox_withdrawal_executions cascade");
  const customers=new PostgresCustomerRepository(pool),repo=new PostgresCustomerPurchaseIntentRepository(pool,"test",{maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}});
  const owner=randomUUID(),customer=(await customers.createOrGet({ownerUserId:owner,type:"pf",displayName:"Synthetic name"})).customer;
  const id=customer.id,provider=`ozav_cus_${id.replaceAll("-","")}`,terms=randomUUID(),wallet=Keypair.generate().publicKey.toBase58();
  await q(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,terms_version,expires_at,accepted_at,encrypted_token,encrypted_acceptance,environment)
   values($1,$2,$3,now(),'accepted','https://ozav.io/terms','2.0',now()-interval '1 day',now()-interval '2 days','{}','{}','test')`,[terms,id,randomUUID()]);
  await q(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode,provider_snapshot,snapshot_version,environment)
   values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full',$7,2,'test')`,[randomUUID(),id,terms,"a".repeat(64),randomUUID(),provider,{requirements_pending:false}]);
  await q("insert into peragus_customer_wallets(customer_id,wallet_address,proof_challenge_id,verified_at,proof_message,proof_signature,environment,network) values($1,$2,$3,now(),'private proof message','private proof signature','test','solana:devnet')",[id,wallet,randomUUID()]);
  await q("insert into peragus_customer_verifications(customer_id,provider_customer_id,verification_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,3,now(),'test')",[id,provider,`ozav_vrf_${id.replaceAll("-","")}`,{status:"completed",checks:{kyc_document:"pass",liveness:"pass",face_match:"pass",aml_name_screening:"not_started"}}]);
  await q("insert into peragus_customer_screenings(customer_id,provider_customer_id,idempotency_key,screening_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,$5,4,now(),'test')",[id,provider,randomUUID(),`ozav_scr_${id.replaceAll("-","")}`,{status:"completed",result:"clear",matchesCount:0,suggestedDecision:"clear",lists:["sanctions","pep"]}]);
  const quoteId=randomUUID(),providerQuote=`ozav_q_${quoteId.replaceAll("-","")}`;
  await q("insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,create_attempted,provider_quote_id,observation,environment) values($1,$2,$3,$4,'1000.00',true,$5,$6,'test')",
   [quoteId,id,randomUUID(),provider,providerQuote,{id:providerQuote,customerId:provider,rateType:"floating",rate:"0.2",source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"},spreadBps:0,rateWithoutSpread:"0.2",amountDeducted:null,expiresAt:null,createdAt:new Date().toISOString()}]);
  const purchase=await new CustomerPurchaseIntentService(repo).record(id,randomUUID(),quoteId);
  const pixRepo=new PostgresCustomerPixRepository(pool,"test");
  const transfer:OzavTransfer={id:`ozav_tr_${randomUUID().replaceAll("-","")}`,status:"awaiting_payment",customerId:provider,
   quoteId:(await pixRepo.context(id,purchase.data.id))!.providerQuoteId,
   source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"sandbox-code",qrCodeImage:null,expiresAt:new Date(Date.now()+60000).toISOString()}},
   destination:{type:"wallet",walletId:"ozav_wal_testmanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
   amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}};
  const ozav={getCustomerCapabilities:async()=>({environment:"test",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
   getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
   getCustomerManagedWallet:async()=>"ozav_wal_testmanaged",
   createCustomerPixTransfer:async()=>({id:transfer.id,transfer}),
   simulateCustomerPixPayment:async()=>{transfer.status="completed";transfer.sourceLegStatus="completed";transfer.destinationLegStatus="completed";},
   findCustomerPixTransfer:async()=>null,getTransfer:async()=>transfer} as any;
  const pix=new CustomerSandboxPixService(pixRepo,ozav),charge=await pix.create(id,randomUUID(),purchase.data.id);
  await pix.simulatePayment(id,charge.data.id);
  const withdrawal=await new CustomerWithdrawalRequestService(new PostgresCustomerWithdrawalRequestRepository(pool,"test")).record(id,randomUUID(),charge.data.id);
  for(const to of ["awaiting_pix","converted","awaiting_approval"] as const)await repo.transitionOperation(purchase.data.id,to,"system:test","test_fixture");
  const operator={id:randomUUID(),email:"operator@example.test",assuranceLevel:"aal2" as const,get mfaVerifiedAt(){return Math.floor(Date.now()/1000);}};
  const second={id:randomUUID(),email:"second@example.test",assuranceLevel:"aal2" as const,get mfaVerifiedAt(){return Math.floor(Date.now()/1000);}};
  const approvals=new WithdrawalOperatorApprovalService(new PostgresWithdrawalOperatorApprovalRepository(pool,"test"),new Set([operator.id,second.id]));
  await approvals.approve(operator,withdrawal.data.id,randomUUID(),"Reviewed the completed sandbox conversion and verified destination.");
  // Fake OZAV send boundary (never the real provider): counts POSTs and answers slowly so
  // a second caller has every chance to reach the claim while the first is still sending.
  let sends=0;const sendId=`ozav_tr_${randomUUID().replaceAll("-","")}`;
  const fake={mode:"test",funding:{getTransfer:async()=>transfer},capabilities:async()=>{},
   identity:async()=>({name:"Synthetic User",cpf:"11144477735",street:"Synthetic Street, 1",city:"Test",country:"BR"}),
   available:async()=>"200.000000",identifyDestination:async()=>{},
   send:async()=>{sends++;await new Promise(resolve=>setTimeout(resolve,50));return{id:sendId,txHash:null};},
   transfer:async()=>({id:sendId,customerId:provider,status:"completed",sourceWalletId:"ozav_wal_testmanaged",sourceCurrency:"USDT",destinationAddress:wallet,network:"solana",
    sourceAmount:"200.000000",targetAmount:"199.500000",sourceLegStatus:"completed",destinationLegStatus:"completed",transactionReference:"synthetic-reference"}),
   find:async()=>null} as any;
  const execution=new SandboxWithdrawalExecutionService(new PostgresSandboxExecutionRepository(pool,"test"),fake,approvals,
   {usdtMint:Keypair.generate().publicKey.toBase58(),reader:{tokenAccountState:async()=>"ready" as const}},{minDelaySeconds:0});
  return{purchaseId:purchase.data.id,withdrawalId:withdrawal.data.id,operator,second,execution,sends:()=>sends,
   refunds:new ManualRefundService(pool,new Set([operator.id,second.id]),true,"test",true)};
 }
 const count=async(sql:string,id:string)=>(await q(sql,[id])).rows[0].n as number;
 const status=async(id:string)=>(await q("select status from peragus_customer_purchase_intents where id=$1",[id])).rows[0].status as string;
 const claims=(id:string)=>count("select count(*)::int n from peragus_operation_status_events where purchase_id=$1 and to_status='sending'",id);
 // A third connection holds the purchase row lock so the racing calls queue on it, then releases.
 async function race(purchaseId:string,start:()=>Promise<unknown>[]){
  const holder=await pool.connect();
  await holder.query("begin");await holder.query("select id from peragus_customer_purchase_intents where id=$1 for update",[purchaseId]);
  const racing=Promise.allSettled(start());
  await new Promise(resolve=>setTimeout(resolve,200));
  await holder.query("commit");holder.release();
  return racing;
 }
 const reasons=(results:PromiseSettledResult<unknown>[])=>JSON.stringify(results.map(r=>r.status==="rejected"?String(r.reason):"ok"));

 it("REAL PG lock contention: the same execute sent twice — one claim, exactly one send POST",async()=>{
  for(let i=0;i<6;i++){
   const f=await fixture(),requestId=randomUUID();
   const results=await race(f.purchaseId,()=>[f.execution.execute(f.operator,f.withdrawalId,requestId),f.execution.execute(f.operator,f.withdrawalId,requestId)]);
   expect(f.sends(),reasons(results)).toBe(1);
   expect(await claims(f.purchaseId)).toBe(1);
   const ok=results.filter(r=>r.status==="fulfilled").map(r=>(r as PromiseFulfilledResult<{replayed:boolean}>).value);
   expect(ok.filter(r=>!r.replayed),reasons(results)).toHaveLength(1);
   expect(await count("select count(*)::int n from peragus_sandbox_withdrawal_executions where withdrawal_request_id=$1 and create_attempted",f.withdrawalId)).toBe(1);
   expect(await status(f.purchaseId)).toBe("sent");
   // A later repeat is a replay and never POSTs again.
   expect((await f.execution.execute(f.operator,f.withdrawalId,requestId)).replayed).toBe(true);
   expect(f.sends()).toBe(1);
  }
 },120000);

 it("REAL PG lock contention: two operators execute together — one claim, one send POST, the other refused",async()=>{
  for(let i=0;i<6;i++){
   const f=await fixture();
   const results=await race(f.purchaseId,()=>[f.execution.execute(f.operator,f.withdrawalId,randomUUID()),f.execution.execute(f.second,f.withdrawalId,randomUUID())]);
   expect(f.sends(),reasons(results)).toBe(1);
   expect(await claims(f.purchaseId)).toBe(1);
   expect(results.filter(r=>r.status==="fulfilled"),reasons(results)).toHaveLength(1);
   for(const r of results)if(r.status==="rejected")expect(String(r.reason)).toMatch(/WITHDRAWAL_EXECUTION_ALREADY_REQUESTED|WITHDRAWAL_OPERATION_NOT_APPROVED/);
   expect(await status(f.purchaseId)).toBe("sent");
  }
 },120000);

 it("REAL PG lock contention: execute vs refund decision started together — never a send and a refund",async()=>{
  for(let i=0;i<8;i++){
   const f=await fixture();
   const execute=()=>f.execution.execute(f.operator,f.withdrawalId,randomUUID());
   const decide=()=>f.refunds.operationDecision(f.operator,f.purchaseId,randomUUID(),"Operator decided to return the Pix payment.");
   const results=await race(f.purchaseId,()=>i%2?[decide(),execute()]:[execute(),decide()]);
   const decisions=await count("select count(*)::int n from peragus_operator_refund_decisions where purchase_id=$1",f.purchaseId);
   // An approved withdrawal blocks the refund decision under the same purchase row lock the
   // claim takes: the send happens once and no refund decision is ever recorded beside it.
   expect(f.sends(),reasons(results)).toBeLessThanOrEqual(1);
   expect(f.sends()+decisions,reasons(results)).toBe(1);
   expect(await claims(f.purchaseId)).toBe(f.sends());
   expect(await status(f.purchaseId)).toBe(f.sends()?"sent":"refund_pending");
   for(const r of results)if(r.status==="rejected")expect(String(r.reason)).toMatch(/REFUND_WITHDRAWAL_IN_PROGRESS|WITHDRAWAL_OPERATION_NOT_APPROVED|WITHDRAWAL_EXECUTION_PREREQUISITES_REQUIRED/);
  }
 },120000);
});
