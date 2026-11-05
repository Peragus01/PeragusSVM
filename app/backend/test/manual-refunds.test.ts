import {randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {Keypair} from "@solana/web3.js";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {ManualRefundService} from "../src/refunds/manual-refunds.js";
import {CustomerOperationHistoryService,parseHistoryQuery} from "../src/purchases/customer-operation-history.js";

const db=new PGlite();
const pool={query:async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length};}} as unknown as Pool;
const customers=new PostgresCustomerRepository(pool),apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec("create role anon;create role authenticated;alter default privileges grant all on tables to anon,authenticated;");
 const dir=new URL("../migrations/",import.meta.url);
 for(const name of (await readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort())await db.exec(await readFile(new URL(name,dir),"utf8"));
},30000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
const reason="Cliente solicita analise manual da devolucao.";
const reviewReason="Operador conferiu o caso e a localizacao dos fundos.";
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
 const service=new ManualRefundService(pool,new Set([operator.id]),true);
 const appFor=async(identity:{id:string;assuranceLevel?:"aal2"}={id:owner},manual=service)=>{
  const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return identity;}},manualRefundService:manual});apps.push(app);return app;
 };
 return {owner,operator,customer,purchase,pix,wallet,provider,service,appFor,requestId:randomUUID()};
}
const headers={authorization:"Bearer valid"};
describe("manual refund case tracking",()=>{
 it("derives the paid amount and records manual review without moving funds",async()=>{
  const f=await fixture(),app=await f.appFor(),path=`/v1/me/operations/${f.purchase}/refund-request`;
  const response=await app.inject({method:"POST",url:path,headers,payload:{request_id:f.requestId,reason}});
  expect(response.statusCode).toBe(201);expect(response.headers["cache-control"]).toBe("no-store");
  const item=response.json().data;
  expect(item).toMatchObject({state:"pending_review",requested_amount:{currency:"BRL",amount:"1000.00"},returned_amount:null,refund_execution_automated:false,provider_verified:false,original_transfer_cancelled:false});
  expect((await app.inject({method:"GET",url:path,headers})).json().data).toEqual(item);
  const history=await new CustomerOperationHistoryService(pool).list(f.customer.id,parseHistoryQuery({}));
  expect(history.data[0]!.refund_request).toMatchObject({id:item.id,state:"pending_review"});
  const detail=await new CustomerOperationHistoryService(pool).get(f.customer.id,f.purchase);
  expect(detail).toEqual(history.data[0]);
  expect(JSON.stringify(detail)).not.toContain("PRIVATE_PROVIDER_DETAILS");
  expect((await db.query("select count(*) as n from settlements")).rows[0]).toEqual({n:0});
  expect((await db.query("select observation->>'status' as state from peragus_customer_sandbox_pix where id=$1",[f.pix])).rows[0]).toEqual({state:"completed"});
 });
 it("replays requests and rejects duplicate operation or changed reason",async()=>{
  const f=await fixture(),a=await f.service.request(f.customer.id,f.purchase,f.requestId,reason);
  const b=await f.service.request(f.customer.id,f.purchase,f.requestId,reason);expect(b.replayed).toBe(true);expect(b.data.id).toBe(a.data.id);
  await expect(f.service.request(f.customer.id,f.purchase,f.requestId,reason+" Alterado.")).rejects.toThrow("REFUND_IDEMPOTENCY_CONFLICT");
  await expect(f.service.request(f.customer.id,f.purchase,randomUUID(),reason)).rejects.toThrow("REFUND_ALREADY_REQUESTED");
 });
 it("isolates customers and blocks unpaid or mismatched funding",async()=>{
  const f=await fixture(),other=await fixture();await f.service.request(f.customer.id,f.purchase,f.requestId,reason);
  await expect(other.service.customerRead(other.customer.id,f.purchase)).rejects.toThrow("REFUND_REQUEST_NOT_FOUND");
  await expect(other.service.request(other.customer.id,f.purchase,randomUUID(),reason)).rejects.toThrow("REFUND_OPERATION_NOT_FOUND");
  await db.query("update peragus_customer_sandbox_pix set observation=jsonb_set(observation,'{sourceLegStatus}','\"pending\"') where id=$1",[other.pix]);
  await expect(other.service.request(other.customer.id,other.purchase,randomUUID(),reason)).rejects.toThrow("REFUND_PAYMENT_NOT_CONFIRMED");
  await db.query("update peragus_customer_sandbox_pix set observation=jsonb_set(jsonb_set(observation,'{sourceLegStatus}','\"completed\"'),'{amounts,source,amount}','\"999.00\"') where id=$1",[other.pix]);
  await expect(other.service.request(other.customer.id,other.purchase,randomUUID(),reason)).rejects.toThrow("REFUND_PAYMENT_NOT_CONFIRMED");
 });
 it("separates approval from manually recorded completion and hides operator details",async()=>{
  const f=await fixture(),request=await f.service.request(f.customer.id,f.purchase,f.requestId,reason),decisionId=randomUUID(),completionId=randomUUID();
  const approved=await f.service.decide(f.operator,request.data.id,decisionId,"approved",reviewReason);
  expect(approved.data).toMatchObject({state:"approved",returned_amount:null,refund_execution_automated:false});
  expect((await f.service.decide(f.operator,request.data.id,decisionId,"approved",reviewReason)).replayed).toBe(true);
  const recorded=await f.service.complete(f.operator,request.data.id,completionId,"950","SYNTHETIC_MANUAL_REFERENCE");
  expect(recorded.data).toMatchObject({state:"refund_recorded",returned_amount:{amount:"950.00"},partial_refund:true,provider_verified:false});
  expect((await f.service.complete(f.operator,request.data.id,completionId,"950.00","SYNTHETIC_MANUAL_REFERENCE")).replayed).toBe(true);
  const safe=JSON.stringify(await f.service.customerRead(f.customer.id,f.purchase));
  for(const secret of [f.operator.id,reviewReason,"SYNTHETIC_MANUAL_REFERENCE",f.provider,"PRIVATE_PROVIDER_DETAILS"])expect(safe).not.toContain(secret);
  await expect(f.service.complete(f.operator,request.data.id,completionId,"900.00","SYNTHETIC_MANUAL_REFERENCE")).rejects.toThrow("REFUND_IDEMPOTENCY_CONFLICT");
  await expect(f.service.complete(f.operator,request.data.id,randomUUID(),"950.00","SYNTHETIC_MANUAL_REFERENCE")).rejects.toThrow("REFUND_ALREADY_RECORDED");
 });
 it("refuses completion without approval and preserves a rejection",async()=>{
  const f=await fixture(),request=await f.service.request(f.customer.id,f.purchase,f.requestId,reason),key=randomUUID();
  await expect(f.service.complete(f.operator,request.data.id,randomUUID(),"1000.00","SYNTHETIC_REFERENCE")).rejects.toThrow("REFUND_APPROVAL_REQUIRED");
  await f.service.decide(f.operator,request.data.id,key,"rejected",reviewReason);
  await expect(f.service.complete(f.operator,request.data.id,randomUUID(),"1000.00","SYNTHETIC_REFERENCE")).rejects.toThrow("REFUND_APPROVAL_REQUIRED");
  await expect(f.service.decide(f.operator,request.data.id,key,"approved",reviewReason)).rejects.toThrow("REFUND_IDEMPOTENCY_CONFLICT");
  await expect(f.service.decide(f.operator,request.data.id,randomUUID(),"approved",reviewReason)).rejects.toThrow("REFUND_ALREADY_DECIDED");
  expect((await f.service.customerRead(f.customer.id,f.purchase)).state).toBe("rejected");
 });
 it("blocks excess recorded amounts and serializes racing decisions and completions",async()=>{
  const f=await fixture(),request=await f.service.request(f.customer.id,f.purchase,f.requestId,reason);
  const decisions=await Promise.allSettled([f.service.decide(f.operator,request.data.id,randomUUID(),"approved",reviewReason),f.service.decide(f.operator,request.data.id,randomUUID(),"approved",reviewReason)]);
  expect(decisions.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  await expect(f.service.complete(f.operator,request.data.id,randomUUID(),"1000.01","SYNTHETIC_REFERENCE")).rejects.toThrow("REFUND_AMOUNT_EXCEEDS_PAYMENT");
  const results=await Promise.allSettled([f.service.complete(f.operator,request.data.id,randomUUID(),"1000.00","SYNTHETIC_REFERENCE"),f.service.complete(f.operator,request.data.id,randomUUID(),"1000.00","SYNTHETIC_REFERENCE")]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const r=(await db.query("select count(*) as n from peragus_manual_refund_completions where refund_request_id=$1",[request.data.id])).rows[0];expect(r).toEqual({n:1});
 });
 it("requires operator role, MFA and a separate non-customer account",async()=>{
  const f=await fixture(),request=await f.service.request(f.customer.id,f.purchase,f.requestId,reason);
  for(const [identity,code] of [[{id:f.operator.id},"WITHDRAWAL_OPERATOR_MFA_REQUIRED"],[{id:randomUUID(),assuranceLevel:"aal2"},"WITHDRAWAL_OPERATOR_REQUIRED"],[{id:f.owner,assuranceLevel:"aal2"},"OPERATOR_ACCOUNT_SEPARATION_REQUIRED"]] as const){
   const service=new ManualRefundService(pool,new Set([f.operator.id,f.owner]),true),app=await f.appFor(identity,service);
   const response=await app.inject({method:"GET",url:`/v1/admin/refund-requests/${request.data.id}`,headers});
   expect(response.statusCode).toBe(403);expect(response.json().error.code).toBe(code);
  }
 });
 it("keeps reads available with writes disabled and validates operator confirmation",async()=>{
  const f=await fixture(),request=await f.service.request(f.customer.id,f.purchase,f.requestId,reason);
  const disabled=new ManualRefundService(pool,new Set([f.operator.id]),false),app=await f.appFor({id:f.owner},disabled);
  const path=`/v1/me/operations/${f.purchase}/refund-request`;
  expect((await app.inject({method:"GET",url:path,headers})).statusCode).toBe(200);
  expect((await app.inject({method:"POST",url:path,headers,payload:{request_id:randomUUID(),reason}})).statusCode).toBe(503);
  const operatorApp=await f.appFor(f.operator);
  const response=await operatorApp.inject({method:"POST",url:`/v1/admin/refund-requests/${request.data.id}/decision`,headers,payload:{request_id:randomUUID(),decision:"approved",reason:reviewReason}});
  expect(response.statusCode).toBe(400);
  const selector=await app.inject({method:"POST",url:path,headers,payload:{request_id:randomUUID(),reason,amount_brl:"2000.00"}});expect(selector.statusCode).toBe(400);
  expect((await app.inject({method:"GET",url:path})).statusCode).toBe(401);
 });
 it("lists cases with bounded pagination and rejects caller customer selectors",async()=>{
  const f=await fixture(),request=await f.service.request(f.customer.id,f.purchase,f.requestId,reason);
  const queue=await f.service.list(f.operator,{state:"all",limit:"50"});
  expect(queue.data.find(r=>r.id===request.data.id)).toMatchObject({state:"pending_review"});
  const page=await f.service.list(f.operator,{state:"all",limit:"1"});
  if(page.meta.has_more){const next=await f.service.list(f.operator,{state:"all",limit:"1",cursor:page.meta.next_cursor!});expect(next.data[0]!.id).not.toBe(page.data[0]!.id);}
  const app=await f.appFor(f.operator);
  for(const query of ["state=invalid","limit=51","customer_id="+f.customer.id,"cursor=invalid"]){
   const response=await app.inject({method:"GET",url:"/v1/admin/refund-requests?"+query,headers});expect(response.statusCode).toBe(400);
  }
 });
 it("enforces immutable records and revoked browser privileges",async()=>{
  const f=await fixture(),request=await f.service.request(f.customer.id,f.purchase,f.requestId,reason);
  await expect(db.query("update peragus_customer_refund_requests set reason='Changed reason' where id=$1",[request.data.id])).rejects.toThrow("append-only");
  await f.service.decide(f.operator,request.data.id,randomUUID(),"approved",reviewReason);
  await f.service.complete(f.operator,request.data.id,randomUUID(),"1000.00","SYNTHETIC_REFERENCE");
  for(const table of ["peragus_customer_refund_requests","peragus_manual_refund_decisions","peragus_manual_refund_completions"]){
   await expect(db.query(`delete from ${table} where ${table.endsWith("requests")?"id":"refund_request_id"}=$1`,[request.data.id])).rejects.toThrow("append-only");
   for(const role of ["anon","authenticated"]){await db.exec(`set role ${role}`);try{await expect(db.query(`select * from ${table}`)).rejects.toThrow();}finally{await db.exec("reset role");}}
  }
 });
});
