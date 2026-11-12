// Ruling 23 under REAL lock contention. PGlite has a single session, so the embedded tests
// can only serialize connections; this file runs against a real PostgreSQL (CI's postgres:17
// service, TEST_INVITE_DATABASE_URL) and is skipped when that variable is not set.
// It creates and drops its own throwaway database, so it never touches the shared one.
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
import type {OzavTransfer} from "../src/providers/ozav-client.js";

const realUrl=process.env.TEST_INVITE_DATABASE_URL;
if(realUrl && !["localhost","127.0.0.1"].includes(new URL(realUrl).hostname))throw Error("DISPOSABLE_LOCAL_DATABASE_REQUIRED");

describe.skipIf(!realUrl)("ruling 23 on real PostgreSQL: concurrent withdrawal approval vs operator refund decision",()=>{
 const dbName=`peragus_race_${randomBytes(6).toString("hex")}`;
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
  return{purchaseId:purchase.data.id,withdrawalId:withdrawal.data.id,operator,
   approvals:new WithdrawalOperatorApprovalService(new PostgresWithdrawalOperatorApprovalRepository(pool,"test"),new Set([operator.id])),
   refunds:new ManualRefundService(pool,new Set([operator.id]),true,"test",true)};
 }
 const count=async(sql:string,id:string)=>(await q(sql,[id])).rows[0].n as number;

 it("REAL PG lock contention: approve vs refund decision started together — exactly one wins, never both",async()=>{
  for(let i=0;i<8;i++){
   const f=await fixture();
   // A third connection holds the purchase row lock so both calls queue on it, then releases.
   const holder=await pool.connect();
   await holder.query("begin");await holder.query("select id from peragus_customer_purchase_intents where id=$1 for update",[f.purchaseId]);
   const approve=()=>f.approvals.approve(f.operator,f.withdrawalId,randomUUID(),"Reviewed the completed sandbox conversion and verified destination.");
   const decide=()=>f.refunds.operationDecision(f.operator,f.purchaseId,randomUUID(),"Operator decided to return the Pix payment.");
   const racing=Promise.allSettled(i%2?[decide(),approve()]:[approve(),decide()]);
   await new Promise(resolve=>setTimeout(resolve,150));
   await holder.query("commit");holder.release();
   const results=await racing;
   expect(results.filter(r=>r.status==="fulfilled"),JSON.stringify(results.map(r=>r.status==="rejected"?String(r.reason):"ok"))).toHaveLength(1);
   const approvals=await count("select count(*)::int n from peragus_withdrawal_operator_approvals where withdrawal_request_id=$1",f.withdrawalId);
   const decisions=await count("select count(*)::int n from peragus_operator_refund_decisions where purchase_id=$1",f.purchaseId);
   expect(approvals+decisions).toBe(1);
   const status=(await q("select status from peragus_customer_purchase_intents where id=$1",[f.purchaseId])).rows[0].status;
   expect(status).toBe(approvals?"approved":"refund_pending");
   for(const r of results)if(r.status==="rejected")expect(String(r.reason)).toMatch(/WITHDRAWAL_REFUND_IN_PROGRESS|REFUND_WITHDRAWAL_IN_PROGRESS/);
  }
 },120000);
});
