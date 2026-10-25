import {randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {Keypair} from "@solana/web3.js";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {CustomerReconciliationService,CustomerReconciliationStatusService,registerCustomerReconciliationWorker,assertCustomerReconciliationSafety} from "../src/jobs/customer-reconciliation.js";
import {createCustomerReconciliationReader} from "../src/purchases/customer-reconciliation-reader.js";
const db=new PGlite();
const pool={query:async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length};}} as unknown as Pool;
const customers=new PostgresCustomerRepository(pool),apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec("create role anon;create role authenticated;alter default privileges grant all on tables to anon,authenticated;");
 const dir=new URL("../migrations/",import.meta.url);
 for(const name of (await readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort())await db.exec(await readFile(new URL(name,dir),"utf8"));
},30000);
beforeEach(async()=>{await db.exec("truncate peragus_customer_reconciliation_events,peragus_customer_reconciliation,peragus_customers cascade");});
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
const headers={authorization:"Bearer synthetic"};
const pending={status:"uncertain",complete:false,review:false};
const reader=(pix=async()=>pending)=>({pix,withdrawal:async()=>pending});
const checkpoint=async()=> (await db.query<any>("select * from peragus_customer_reconciliation order by created_at,id")).rows[0];
async function fixture(){
 const owner=randomUUID(),operator={id:randomUUID(),assuranceLevel:"aal2" as const};
 const customer=(await customers.createOrGet({ownerUserId:owner,type:"pf",displayName:"Synthetic customer"})).customer;
 const provider="ozav_cus_"+randomUUID().replaceAll("-",""),terms=randomUUID(),quote=randomUUID(),purchase=randomUUID(),pix=randomUUID(),wallet=Keypair.generate().publicKey.toBase58();
 await db.query(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,state,terms_url,terms_version,expires_at,accepted_at,encrypted_token,encrypted_acceptance)
 values($1,$2,$3,now(),'accepted','https://ozav.io/terms','2.0',now(),now(),'{}','{}')`,[terms,customer.id,randomUUID()]);
 await db.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,provider_status,verification_mode,provider_snapshot,snapshot_version)
 values($1,$2,1,$3,$4,$5,'{}','linked',$6,'approved','full','{}',1)`,[randomUUID(),customer.id,terms,"a".repeat(64),randomUUID(),provider]);
 await db.query(`insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl) values($1,$2,$3,$4,1000)`,[quote,customer.id,randomUUID(),provider]);
 await db.query(`insert into peragus_customer_purchase_intents(id,customer_id,request_id,quote_id,provider_customer_id,source_amount_brl,estimated_target_amount_usdt,quote_snapshot,wallet_address,wallet_verified_at,evidence_snapshot)
 values($1,$2,$3,$4,$5,1000,200,'{}',$6,now(),'{}')`,[purchase,customer.id,randomUUID(),quote,provider,wallet]);
 const transfer="ozav_tr_"+randomUUID().replaceAll("-","");
 await db.query(`insert into peragus_customer_sandbox_pix(id,customer_id,request_id,purchase_intent_id,provider_customer_id,provider_quote_id,source_amount_brl,wallet_address,provider_wallet_id,idempotency_key,create_attempted,provider_transfer_id,observation)
 values($1,$2,$3,$4,$5,'ozav_q_example',1000,$6,'ozav_wal_example',$7,true,$8,$9)`,[pix,customer.id,randomUUID(),purchase,provider,wallet,randomUUID(),transfer,{id:transfer,customerId:provider,quoteId:"ozav_q_example",source:{type:"fiat_payment",currency:"BRL",rail:"pix"},status:"completed",sourceLegStatus:"completed",destinationLegStatus:"completed",amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}},private_data:"PRIVATE_PROVIDER_DETAILS"}]);
 return {owner,operator,customer,purchase,pix,wallet,provider,transfer};
}
function rawPix(f:Awaited<ReturnType<typeof fixture>>){return {
 object:"transfer",id:f.transfer,customer_id:f.provider,quote_id:"ozav_q_example",status:"completed",
 source:{type:"fiat_payment",currency:"BRL",rail:"pix"},destination:{type:"wallet",wallet_id:"ozav_wal_example"},
 source_leg:{status:"completed"},destination_leg:{status:"completed"},amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}
};}
async function withdrawalFixture(){
 const f=await fixture(),withdrawal=randomUUID(),approval=randomUUID(),execution=randomUUID(),send="ozav_tr_"+randomUUID().replaceAll("-","");
 await db.query(`insert into peragus_customer_withdrawal_requests(id,customer_id,request_id,pix_id,purchase_intent_id,provider_customer_id,provider_wallet_id,provider_transfer_id,amount_usdt,wallet_address,wallet_verified_at,evidence_snapshot)
  values($1,$2,$3,$4,$5,$6,'ozav_wal_example',$7,200,$8,now(),'{}')`,[withdrawal,f.customer.id,randomUUID(),f.pix,f.purchase,f.provider,f.transfer,f.wallet]);
 await db.query(`insert into peragus_withdrawal_operator_approvals(id,withdrawal_request_id,customer_id,operator_user_id,request_id,assurance_level,reason,amount_usdt,wallet_address)
  values($1,$2,$3,$4,$5,'aal2','Synthetic operator review.',200,$6)`,[approval,withdrawal,f.customer.id,f.operator.id,randomUUID(),f.wallet]);
 await db.query(`insert into peragus_sandbox_withdrawal_executions(id,withdrawal_request_id,customer_id,approval_id,approver_id,operator_id,request_id,pix_id,provider_customer_id,provider_wallet_id,provider_quote_id,funding_transfer_id,amount_brl,amount_usdt,wallet_address,verified_at,idempotency_key,create_attempted)
  values($1,$2,$3,$4,$5,$5,$6,$7,$8,'ozav_wal_example','ozav_q_example',$9,1000,200,$10,now(),$11,true)`,[execution,withdrawal,f.customer.id,approval,f.operator.id,randomUUID(),f.pix,f.provider,f.transfer,f.wallet,"peragus-send-"+execution]);
 const body={object:"transfer",id:send,customer_id:f.provider,status:"completed",
  source:{type:"wallet",wallet_id:"ozav_wal_example",currency:"USDT",chain:"solana"},destination:{type:"crypto_address",address:f.wallet,network:"solana",currency:"USDT"},
  source_leg:{status:"completed"},destination_leg:{status:"completed"},amounts:{source:{currency:"USDT",amount:"200"}},
  settlement_references:{tx_hash:"sim_synthetic_reference",network:"solana"}};
 return {...f,withdrawal,execution,send,body};
}
describe("durable GET-only customer reconciliation",()=>{
 it("discovers a completed Pix once, validates real reader evidence and writes one immutable event",async()=>{
  const f=await fixture();const transport=vi.fn(async()=>({statusCode:200,body:rawPix(f)}));
  const service=new CustomerReconciliationService(pool,createCustomerReconciliationReader(pool,"ozav_sk_test_example",transport));
  expect(await service.run()).toMatchObject({processed:true,kind:"pix",state:"provider_terminal",attempts:1,saved:true});
  expect(await service.run()).toEqual({processed:false});expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]![0]).toBe(`/v2/transfers/${f.transfer}`);
  const row=await checkpoint();expect(row.state).toBe("provider_terminal");
  expect((await db.query("select count(*)::int as n from peragus_customer_reconciliation_events")).rows[0]).toEqual({n:1});
  await expect(db.query("update peragus_customer_reconciliation_events set state='pending'")).rejects.toThrow("append-only");
  expect((await db.query("select create_attempted,simulation_attempted from peragus_customer_sandbox_pix where id=$1",[f.pix])).rows[0]).toEqual({create_attempted:true,simulation_attempted:false});
  expect((await db.query("select count(*)::int as n from settlements")).rows[0]).toEqual({n:0});
 });
 it("does not discover an unattempted Pix or create a transfer",async()=>{
  const f=await fixture();await db.query("update peragus_customer_sandbox_pix set create_attempted=false,provider_transfer_id=null,observation=null where id=$1",[f.pix]);
  const pix=vi.fn(async()=>pending),service=new CustomerReconciliationService(pool,reader(pix));
  expect(await service.run()).toEqual({processed:false});expect(pix).not.toHaveBeenCalled();
 });
 it("recovers missing binding by listing GETs and never resets the original attempt",async()=>{
  const f=await fixture();await db.query("update peragus_customer_sandbox_pix set provider_transfer_id=null,observation=null where id=$1",[f.pix]);
  const paths:string[]=[];
  const transport=async(path:string)=>{paths.push(path);return {statusCode:200,body:path.includes("?")?{data:[{id:f.transfer,customer_id:f.provider,metadata:{peragus_pix_id:f.pix}}],has_more:false}:rawPix(f)};};
  expect(await new CustomerReconciliationService(pool,createCustomerReconciliationReader(pool,"ozav_sk_test_example",transport)).run()).toMatchObject({state:"provider_terminal"});
  expect(paths).toHaveLength(2);expect(paths[0]).toContain("/v2/transfers?");
  expect((await db.query("select create_attempted,provider_transfer_id from peragus_customer_sandbox_pix where id=$1",[f.pix])).rows[0]).toEqual({create_attempted:true,provider_transfer_id:f.transfer});
 });
 it("retains uncertainty and backs off rather than treating an empty list as failure",async()=>{
  const f=await fixture();await db.query("update peragus_customer_sandbox_pix set provider_transfer_id=null,observation=null where id=$1",[f.pix]);
  const transport=vi.fn(async()=>({statusCode:200,body:{data:[],has_more:false}}));
  const service=new CustomerReconciliationService(pool,createCustomerReconciliationReader(pool,"ozav_sk_test_example",transport));
  expect(await service.run()).toMatchObject({state:"pending",manualReviewRequired:false});
  expect(await service.run()).toEqual({processed:false});expect(transport).toHaveBeenCalledTimes(1);
  expect((await checkpoint()).last_status).toBe("uncertain");
 });
 it("blocks mismatched evidence without overwriting the stored observation",async()=>{
  const f=await fixture(),body=rawPix(f);body.customer_id="ozav_cus_foreign";
  const before=(await db.query("select observation from peragus_customer_sandbox_pix where id=$1",[f.pix])).rows[0];
  const service=new CustomerReconciliationService(pool,createCustomerReconciliationReader(pool,"ozav_sk_test_example",async()=>({statusCode:200,body})));
  expect(await service.run()).toMatchObject({state:"needs_review",errorCode:"EVIDENCE_MISMATCH"});
  expect((await db.query("select observation from peragus_customer_sandbox_pix where id=$1",[f.pix])).rows[0]).toEqual(before);
 });
 it("caps attempts and marks an aged order for review without recording provider errors",async()=>{
  await fixture();const service=new CustomerReconciliationService(pool,reader(async()=>{throw Error("PRIVATE_PROVIDER_SECRET");}));
  await service.discover();await db.query("update peragus_customer_reconciliation set attempts=119,created_at=now()-interval '20 minutes'");
  expect(await service.run()).toMatchObject({attempts:120,state:"needs_review",errorCode:"ATTEMPTS_EXHAUSTED",manualReviewRequired:true});
  const view=JSON.stringify((await db.query("select * from peragus_customer_reconciliation_events")).rows);
  expect(view).not.toContain("PRIVATE_PROVIDER_SECRET");expect(await service.run()).toEqual({processed:false});
 });
 it("reclaims an abandoned lease but fences a stale worker's checkpoint update",async()=>{
  await fixture();let release!:(value:typeof pending)=>void;
  const barrier=new Promise<typeof pending>(resolve=>{release=resolve;});let entered=false;
  const slow=new CustomerReconciliationService(pool,reader(async()=>{entered=true;return barrier;}));
  const first=slow.run();while(!entered)await new Promise(resolve=>setTimeout(resolve,1));
  const fast=new CustomerReconciliationService(pool,reader());
  expect(await fast.run()).toEqual({processed:false});
  await db.query("update peragus_customer_reconciliation set lease_until=now()-interval '1 second'");
  expect(await fast.run()).toMatchObject({processed:true,attempts:2,saved:true});
  release(pending);expect(await first).toMatchObject({processed:true,attempts:1,saved:false});
  expect((await db.query("select count(*)::int as n from peragus_customer_reconciliation_events")).rows[0]).toEqual({n:1});
 });
 it("records exhausted recovery after a crash on the final attempt",async()=>{
  await fixture();const pix=vi.fn(async()=>pending),service=new CustomerReconciliationService(pool,reader(pix));
  await service.discover();await db.query("update peragus_customer_reconciliation set attempts=120,lease_token=$1,lease_until=now()-interval '1 second'",[randomUUID()]);
  expect(await service.run()).toEqual({processed:false});expect(pix).not.toHaveBeenCalled();
  expect(await checkpoint()).toMatchObject({state:"needs_review",last_error_code:"ATTEMPTS_EXHAUSTED",lease_token:null});
 });
 it("flags fifteen-minute pending orders without stopping GET recovery prematurely",async()=>{
  await fixture();const service=new CustomerReconciliationService(pool,reader());await service.discover();
  await db.query("update peragus_customer_reconciliation set created_at=now()-interval '16 minutes'");
  expect(await service.run()).toMatchObject({state:"pending",manualReviewRequired:true});
 });
 it("keeps browser roles unprivileged",async()=>{
  for(const role of ["anon","authenticated"]){
   const result=await db.query<{allowed:boolean}>("select has_table_privilege($1,'peragus_customer_reconciliation','select') or has_table_privilege($1,'peragus_customer_reconciliation_events','insert') as allowed",[role]);
   expect(result.rows[0]!.allowed).toBe(false);
  }
 });
 it("requires allowlisted MFA operators and rejects selectors without exposing private DB errors",async()=>{
  const f=await fixture(),status=new CustomerReconciliationStatusService(pool,new Set([f.operator.id]));
  const appFor=async(user:any,service=status)=>{const app=await buildApp({customerAccess:{customers,authenticate:async()=>user},customerReconciliationStatusService:service});apps.push(app);return app;};
  const url="/v1/admin/customer-reconciliation";
  expect((await (await appFor(f.operator)).inject({method:"GET",url,headers})).statusCode).toBe(200);
  expect((await (await appFor({id:f.operator.id})).inject({method:"GET",url,headers})).statusCode).toBe(403);
  const client=await (await appFor({id:f.owner,assuranceLevel:"aal2"})).inject({method:"GET",url,headers});
  expect(client.statusCode).toBe(403);expect(client.json().error.code).toBe("OPERATOR_ACCOUNT_SEPARATION_REQUIRED");
  const app=await appFor(f.operator);
  expect((await app.inject({method:"GET",url:url+"?customer_id="+f.customer.id,headers})).statusCode).toBe(400);
  expect((await app.inject({method:"GET",url})).statusCode).toBe(401);
  const broken=new CustomerReconciliationStatusService({query:async()=>{throw Error("PRIVATE_DATABASE_SECRET");}} as any,new Set([f.operator.id]));
  const failed=await (await appFor(f.operator,broken)).inject({method:"GET",url,headers});expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain("PRIVATE_DATABASE_SECRET");
 });
 it("registers an isolated single-consumer minute tick with retries disabled",async()=>{
  const boss={createQueue:vi.fn(),schedule:vi.fn(),work:vi.fn()},service={run:vi.fn(async()=>({processed:false as const}))};
  await registerCustomerReconciliationWorker(boss as any,service);
  expect(boss.createQueue).toHaveBeenCalledWith("customer-sandbox-reconciliation",expect.objectContaining({retryLimit:0}));
  expect(boss.schedule).toHaveBeenCalledWith("customer-sandbox-reconciliation","* * * * *",{},expect.objectContaining({retryLimit:0}));
  expect(boss.work.mock.calls[0]![1]).toMatchObject({localConcurrency:1});
 });
 it("rejects live keys and any financial enablement at the worker boundary",()=>{
  const safe={DATABASE_URL:"postgresql://postgres.lybdkqkbwlfwvmmvstzi:synthetic@aws-1-sa-east-1.pooler.supabase.com:5432/postgres",DATABASE_SSL:true,OZAV_API_KEY:"ozav_sk_test_example",OZAV_ONRAMP_WRITES_ENABLED:false,OZAV_OFFRAMP_WRITES_ENABLED:false,SOLANA_COSIGNING_ENABLED:false,SOLANA_CONTINGENCY_RESERVE_ENABLED:false,PERAGUS_SANDBOX_DEMO_ENABLED:false};
  expect(()=>assertCustomerReconciliationSafety(safe)).not.toThrow();
  expect(()=>assertCustomerReconciliationSafety({...safe,OZAV_ONRAMP_WRITES_ENABLED:true})).toThrow();
  expect(()=>assertCustomerReconciliationSafety({...safe,OZAV_API_KEY:"ozav_sk_live_example"})).toThrow();
  expect(()=>createCustomerReconciliationReader(pool,"ozav_sk_live_example")).toThrow();
 });
 it("recovers a withdrawal with GET only, preserving unknown target and the original pilot claim",async()=>{
  const f=await withdrawalFixture();const paths:string[]=[];
  const transport=async(path:string)=>{paths.push(path);return {statusCode:200,body:path.includes("?")?{data:[{id:f.send,customer_id:f.provider,metadata:{peragus_execution_id:f.execution}}],has_more:false}:f.body};};
  const safe=createCustomerReconciliationReader(pool,"ozav_sk_test_example",transport);
  expect(Object.keys(safe)).toEqual(["pix","withdrawal"]);
  expect(await safe.withdrawal(f.customer.id,f.withdrawal)).toEqual({status:"completed",complete:true,review:false});
  expect(paths).toHaveLength(2);
  const saved=(await db.query<any>("select create_attempted,provider_send_id,observation,closed_at from peragus_sandbox_withdrawal_executions where id=$1",[f.execution])).rows[0];
  expect(saved.create_attempted).toBe(true);expect(saved.provider_send_id).toBe(f.send);expect(saved.closed_at).toBeNull();expect(saved.observation.targetAmount).toBeNull();
  await expect(safe.withdrawal(randomUUID(),f.withdrawal)).rejects.toThrow("WITHDRAWAL_EXECUTION_NOT_FOUND");
  expect(paths).toHaveLength(2);
 });
 it("refuses withdrawal destination mismatches and incomplete completion evidence",async()=>{
  const f=await withdrawalFixture();
  await db.query("update peragus_sandbox_withdrawal_executions set provider_send_id=$1 where id=$2",[f.send,f.execution]);
  const body={...f.body,destination:{...f.body.destination,address:Keypair.generate().publicKey.toBase58()}};
  const safe=createCustomerReconciliationReader(pool,"ozav_sk_test_example",async()=>({statusCode:200,body}));
  await expect(safe.withdrawal(f.customer.id,f.withdrawal)).rejects.toThrow("WITHDRAWAL_PROVIDER_CONTEXT_MISMATCH");
  body.destination.address=f.wallet;body.destination_leg.status="pending";
  expect(await safe.withdrawal(f.customer.id,f.withdrawal)).toEqual({status:"completed",complete:false,review:true});
 });
 it("discovers only attempted withdrawals and completes their checkpoint without another send",async()=>{
  const f=await withdrawalFixture(),safe=createCustomerReconciliationReader(pool,"ozav_sk_test_example",async(path)=>({statusCode:200,body:path.includes("?")?{data:[{id:f.send,customer_id:f.provider,metadata:{peragus_execution_id:f.execution}}],has_more:false}:f.body}));
  const service=new CustomerReconciliationService(pool,safe);await service.discover();
  await db.query("update peragus_customer_reconciliation set state='provider_terminal' where pix_id is not null");
  expect(await service.run()).toMatchObject({kind:"withdrawal",state:"provider_terminal",saved:true});
  expect(await service.run()).toEqual({processed:false});
  expect((await db.query("select count(*)::int as n from peragus_sandbox_withdrawal_executions")).rows[0]).toEqual({n:1});
 });

});
