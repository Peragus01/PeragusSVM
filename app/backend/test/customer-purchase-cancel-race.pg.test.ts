// Task 13b minor 1 under REAL lock contention: a Pix create (claim under the purchase row
// lock) racing a customer cancel never yields both an expired-by-cancel operation and a
// Pix POST. PGlite serializes connections, so this runs against CI's postgres:17
// (TEST_INVITE_DATABASE_URL); it skips locally and fails in CI if the URL is missing.
import {randomBytes,randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {Keypair} from "@solana/web3.js";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {enableRuntimeControls} from "./helpers/runtime-controls.js";
import {realPostgresUrl} from "./helpers/real-postgres.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresCustomerPurchaseIntentRepository} from "../src/repositories/postgres-customer-purchase-intents.js";
import {PostgresCustomerPixRepository} from "../src/repositories/postgres-customer-sandbox-pix.js";
import {PostgresCustomerWithdrawalRequestRepository} from "../src/repositories/postgres-customer-withdrawal-requests.js";
import {PostgresPurchaseCancelRepository} from "../src/repositories/postgres-customer-purchase-cancel.js";
import {CustomerPixService} from "../src/purchases/customer-sandbox-pix.js";
import {CustomerPurchaseCancelService} from "../src/purchases/customer-purchase-cancel.js";
import {PurchaseProgression} from "../src/purchases/purchase-progression.js";
import {ManualRefundService} from "../src/refunds/manual-refunds.js";
import type {OzavTransfer} from "../src/providers/ozav-client.js";

const realUrl=realPostgresUrl();

describe.skipIf(!realUrl)("policy 7.1 on real PostgreSQL: concurrent Pix create vs customer cancel",()=>{
 const dbName=`peragus_cancel_race_${randomBytes(6).toString("hex")}`;
 let admin:Pool,pool:Pool;
 const q=(sql:string,args?:unknown[])=>pool.query(sql,args as unknown[]);
 beforeAll(async()=>{
  admin=new Pool({connectionString:realUrl,max:1});
  await admin.query(`create database ${dbName}`);
  const url=new URL(realUrl!);url.pathname=`/${dbName}`;
  pool=new Pool({connectionString:url.toString(),max:12});
  const dir=new URL("../migrations/",import.meta.url);
  for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await q(await readFile(new URL(f,dir),"utf8"));
  await q("insert into peragus_database_environment(environment) values('live')");
  await enableRuntimeControls({query:q});
 },120000);
 afterAll(async()=>{
  await pool?.end();
  if(admin){try{await admin.query(`drop database if exists ${dbName} with (force)`);}finally{await admin.end();}}
 });

 async function fixture(){
  const purchases=new PostgresCustomerPurchaseIntentRepository(pool,"live",{maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}});
  const owner=randomUUID(),customer=(await new PostgresCustomerRepository(pool).createOrGet({ownerUserId:owner,type:"pf",displayName:"Synthetic name"})).customer;
  const id=customer.id,provider=`ozav_cus_${id.replaceAll("-","")}`,session=randomUUID(),wallet=Keypair.generate().publicKey.toBase58();
  await q(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,terms_version,expires_at,accepted_at,encrypted_token,encrypted_acceptance,environment)
   values($1,$2,$3,now(),'accepted','https://ozav.io/terms','2.0',now()-interval '1 day',now()-interval '2 days','{}','{}','live')`,[session,id,randomUUID()]);
  await q(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode,provider_snapshot,snapshot_version,environment)
   values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full',$7,2,'live')`,[randomUUID(),id,session,"a".repeat(64),randomUUID(),provider,{requirements_pending:false}]);
  await q("insert into peragus_customer_wallets(customer_id,wallet_address,proof_challenge_id,verified_at,proof_message,proof_signature,environment,network) values($1,$2,$3,now(),'private proof message','private proof signature','live','solana:mainnet')",[id,wallet,randomUUID()]);
  await q("insert into peragus_customer_verifications(customer_id,provider_customer_id,verification_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,3,now(),'live')",[id,provider,`ozav_vrf_${id.replaceAll("-","")}`,{status:"completed",checks:{kyc_document:"pass",liveness:"pass",face_match:"pass",aml_name_screening:"not_started"}}]);
  await q("insert into peragus_customer_screenings(customer_id,provider_customer_id,idempotency_key,screening_id,observation,revision,refreshed_at,environment) values($1,$2,$3,$4,$5,4,now(),'live')",[id,provider,randomUUID(),`ozav_scr_${id.replaceAll("-","")}`,{status:"completed",result:"clear",matchesCount:0,suggestedDecision:"clear",lists:["sanctions","pep"]}]);
  const quoteId=randomUUID(),providerQuoteId=`ozav_q_${quoteId.replaceAll("-","")}`;
  await q(`insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,create_attempted,provider_quote_id,observation,environment,facility_terms_version,locked_usdt_amount)
   values($1,$2,$3,$4,'1000.00',true,$5,$6,'live','2.0','200.000000')`,[quoteId,id,randomUUID(),provider,providerQuoteId,
   {id:providerQuoteId,customerId:provider,rateType:"floating",rate:"0.2",source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"},spreadBps:0,rateWithoutSpread:"0.2",amountDeducted:null,expiresAt:null,createdAt:new Date().toISOString()}]);
  const p=(await purchases.record(id,randomUUID(),quoteId)).record,pixRepo=new PostgresCustomerPixRepository(pool,"live");
  let posts=0;
  const awaiting:OzavTransfer={id:`ozav_tr_${randomUUID().replaceAll("-","")}`,status:"awaiting_payment",customerId:provider,quoteId:providerQuoteId,
   source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"000201live-br-code",qrCodeImage:null,expiresAt:new Date(Date.now()+600000).toISOString()}},
   destination:{type:"wallet",walletId:"ozav_wal_livemanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
   amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}};
  const ozav={getCustomerCapabilities:async()=>({environment:"live",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
   getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
   getCustomerManagedWallet:async()=>"ozav_wal_livemanaged",
   createCustomerPixTransfer:async()=>{posts++;return{id:awaiting.id,transfer:awaiting,facility:{locked:true,state:"locked",reason:null,amount:"200.000000",currency:"USDT",deadlineAt:"2099-01-01T00:00:00Z"}};},
   simulateCustomerPixPayment:async()=>{throw new Error("never in live");},
   findCustomerPixTransfer:async()=>null,getTransfer:async()=>awaiting} as any;
  const pix=new CustomerPixService(pixRepo,ozav,"live",purchases);
  const progression=new PurchaseProgression({pool,mode:"live",operations:purchases,
   withdrawals:new PostgresCustomerWithdrawalRequestRepository(pool,"live"),refunds:new ManualRefundService(pool,new Set<string>(),true,"live",true),pix:{repo:pixRepo,provider:ozav}});
  const cancels=new CustomerPurchaseCancelService(new PostgresPurchaseCancelRepository(pool,"live"),progression);
  return{id,p,pix,cancel:()=>cancels.cancel(id,p.id,randomUUID()),create:()=>pix.create(id,randomUUID(),p.id),posts:()=>posts};
 }

 it("exactly one of: the operation expired by the cancel, or the Pix was POSTed (instructions hidden)",async()=>{
  for(let i=0;i<10;i++){
   const f=await fixture();
   const [created,cancelled]=i%2?await Promise.allSettled([f.create(),f.cancel()]):(await Promise.allSettled([f.cancel(),f.create()])).reverse() as [PromiseSettledResult<Awaited<ReturnType<typeof f.create>>>,PromiseSettledResult<unknown>];
   const reasons=(await q("select reason from peragus_operation_status_events where purchase_id=$1",[f.p.id])).rows.map(r=>r.reason as string);
   const expiredByCancel=reasons.includes("CUSTOMER_CANCELLED");
   expect(cancelled.status).toBe("fulfilled");
   expect(Number(expiredByCancel)+f.posts()).toBe(1);
   if(expiredByCancel)expect(created.status).toBe("rejected");
   else expect(created.status==="fulfilled" && created.value.data.payment_instructions).toBeNull();
  }
 },120000);
});
