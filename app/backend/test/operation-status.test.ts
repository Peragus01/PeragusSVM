import {randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {PGlite} from "@electric-sql/pglite";
import {Keypair} from "@solana/web3.js";
import {afterEach,describe,expect,it,vi} from "vitest";
import {runMigrations} from "../scripts/lib/migration-runner.mjs";
import {canTransition,OPEN_STATUSES,OPERATION_STATUSES,brlToCents,centsToBrl,purchaseLimits,type OperationStatus} from "../src/purchases/operation-status.js";

vi.setConfig({testTimeout:60000});
const MIGRATION="045_purchase_operation_status.sql";
const dbs:PGlite[]=[];
afterEach(async()=>{await Promise.all(dbs.splice(0).map(db=>db.close()));});
async function migrated(stopBefore?:string){
 const db=new PGlite();dbs.push(db);
 await db.exec("create role anon; create role authenticated;");
 const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort()){
  if(stopBefore && f>=stopBefore)break;
  await db.exec(await readFile(new URL(f,dir),"utf8"));
 }
 return db;
}
// Inserts a legacy (pre-045) record-only purchase intent with its quote.
async function legacyIntent(db:PGlite,customerId:string,createdAt:string){
 const quote=randomUUID(),id=randomUUID();
 // Fixture only: skip the onboarding foreign keys behind the quote (and triggers).
 await db.exec("set session_replication_role=replica");
 try{
  await db.query("insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,environment) values($1,$2,$3,'ozav_cus_synthetic','500.00','test')",[quote,customerId,randomUUID()]);
  await db.query(`insert into peragus_customer_purchase_intents(id,customer_id,request_id,quote_id,provider_customer_id,source_amount_brl,estimated_target_amount_usdt,quote_snapshot,wallet_address,wallet_verified_at,evidence_snapshot,environment,wallet_proof_network,created_at)
   values($1,$2,$3,$4,'ozav_cus_synthetic','500.00','100.000000','{}',$5,now(),'{}','test','solana:devnet',$6)`,[id,customerId,randomUUID(),quote,Keypair.generate().publicKey.toBase58(),createdAt]);
 }finally{await db.exec("set session_replication_role=origin");}
 return id;
}
async function customer(db:PGlite){
 const id=randomUUID();
 await db.query("insert into peragus_customers(id,owner_user_id,customer_type,display_name) values($1,$2,'pf','Synthetic name')",[id,randomUUID()]);
 return id;
}

describe("canTransition",()=>{
 it("accepts the happy chain of the spec",()=>{
  const chain:OperationStatus[]=["quoted","accepted","awaiting_pix","pix_confirmed","converted","awaiting_approval","approved","sending","sent","delivered_verified"];
  for(let i=0;i<chain.length-1;i++)expect(canTransition(chain[i]!,chain[i+1]!),`${chain[i]}->${chain[i+1]}`).toBe(true);
 });
 it("refuses going back, leaving a terminal state and entering quoted",()=>{
  expect(canTransition("sending","awaiting_pix")).toBe(false);
  for(const to of OPERATION_STATUSES){
   // expired/failed reopen only as refund_pending (operator decision, paid Pix; see 048).
   for(const terminal of ["delivered_verified","expired","failed","refunded"] as const)
    expect(canTransition(terminal,to)).toBe((terminal==="expired" || terminal==="failed") && to==="refund_pending");
   expect(canTransition(to,"quoted")).toBe(false);
   expect(canTransition(to,to)).toBe(false);
  }
  // Ruling 39 (056): re-verification out of a delivery review; the SQL guard checks the origin.
  expect(canTransition("needs_review","delivered_verified")).toBe(true);
  expect(canTransition("needs_review","sent")).toBe(false);
  expect(canTransition("pix_confirmed","failed")).toBe(false);
 });
 it("sends an ambiguous accepted operation to review (lock outcome unknown), never to refund",()=>{
  expect(canTransition("accepted","needs_review")).toBe(true);
  expect(canTransition("accepted","refund_pending")).toBe(false);
  expect(canTransition("needs_review","awaiting_pix")).toBe(false);
 });
 it("lets an operator refund decision reopen closed or in-flight paid operations as refund_pending",()=>{
  for(const from of ["needs_review","pix_confirmed","converted","awaiting_approval","expired","failed"] as const)
   expect(canTransition(from,"refund_pending"),from).toBe(true);
  for(const from of ["delivered_verified","refunded","approved","sending","sent"] as const)expect(canTransition(from,"refund_pending"),from).toBe(false);
 });
 it("treats everything but delivered_verified, expired, failed and refunded as open",()=>{
  expect([...OPEN_STATUSES].sort()).toEqual(OPERATION_STATUSES.filter(s=>!["delivered_verified","expired","failed","refunded"].includes(s)).sort());
 });
});

describe("purchase limits",()=>{
 it("parses BRL strings into bigint cents without floats",()=>{
  expect(brlToCents("1000")).toBe(100000n);expect(brlToCents("1000.5")).toBe(100050n);expect(brlToCents("999.99")).toBe(99999n);
  expect(centsToBrl(100000n)).toBe("1000.00");expect(centsToBrl(5n)).toBe("0.05");
  expect(purchaseLimits({PURCHASE_MIN_BRL:"1000.00",PURCHASE_MAX_BRL:"1000.00"})).toEqual({minCents:100000n,maxCents:100000n});
  for(const bad of ["","1e3","-1","1.234"," 1"])expect(()=>brlToCents(bad)).toThrow();
 });
 it("defaults PURCHASE_MIN_BRL/PURCHASE_MAX_BRL to 1000.00 and PURCHASE_MAX_OPEN_GLOBAL to 1, and refuses min above max",async()=>{
  try{
   vi.stubEnv("PERAGUS_DEPLOYMENT_ENV","staging");
   for(const k of ["PURCHASE_MIN_BRL","PURCHASE_MAX_BRL","PURCHASE_MAX_OPEN_GLOBAL"])vi.stubEnv(k,undefined);
   vi.resetModules();
   const env=(await import("../src/config/env.js")).getEnv();
   expect({min:env.PURCHASE_MIN_BRL,max:env.PURCHASE_MAX_BRL,cap:env.PURCHASE_MAX_OPEN_GLOBAL}).toEqual({min:"1000.00",max:"1000.00",cap:1});
   vi.stubEnv("PURCHASE_MIN_BRL","1000.01");vi.resetModules();
   const fresh=(await import("../src/config/env.js")).getEnv;
   expect(()=>fresh()).toThrow(expect.objectContaining({code:"ENVIRONMENT_CONFIGURATION_INVALID",fields:["PURCHASE_MAX_BRL"]}));
  }finally{vi.unstubAllEnvs();vi.resetModules();}
 });
});

describe("operator action policy configuration",()=>{
 const keys=["OPERATOR_MFA_MAX_AGE_SECONDS","OPERATOR_EXECUTION_MIN_DELAY_SECONDS","OPERATOR_FOUR_EYES_ENABLED"];
 it("defaults to fresh MFA within 300 s, a 900 s execution delay and four eyes off; refuses MFA older than 300 s",async()=>{
  try{
   vi.stubEnv("PERAGUS_DEPLOYMENT_ENV","staging");
   for(const k of keys)vi.stubEnv(k,undefined);
   vi.resetModules();
   const env=(await import("../src/config/env.js")).getEnv();
   expect({mfa:env.OPERATOR_MFA_MAX_AGE_SECONDS,delay:env.OPERATOR_EXECUTION_MIN_DELAY_SECONDS,fourEyes:env.OPERATOR_FOUR_EYES_ENABLED}).toEqual({mfa:300,delay:900,fourEyes:false});
   for(const [key,value] of [["OPERATOR_MFA_MAX_AGE_SECONDS","301"],["OPERATOR_MFA_MAX_AGE_SECONDS","0"],["OPERATOR_EXECUTION_MIN_DELAY_SECONDS","-1"],["OPERATOR_FOUR_EYES_ENABLED","yes"]] as const){
    for(const k of keys)vi.stubEnv(k,undefined);
    vi.stubEnv(key,value);vi.resetModules();
    const fresh=(await import("../src/config/env.js")).getEnv;
    expect(()=>fresh()).toThrow(expect.objectContaining({code:"ENVIRONMENT_CONFIGURATION_INVALID",fields:[key]}));
   }
  }finally{vi.unstubAllEnvs();vi.resetModules();}
 });
});

describe("operation status in SQL (migration 045)",()=>{
 it("peragus_operation_can_transition mirrors canTransition for every pair",async()=>{
  const db=await migrated();
  const r=await db.query<{f:string;t:string;ok:boolean}>(`select f,t,peragus_operation_can_transition(f,t) ok from unnest($1::text[]) f cross join unnest($1::text[]) t`,[OPERATION_STATUSES]);
  expect(r.rows).toHaveLength(OPERATION_STATUSES.length**2);
  for(const row of r.rows)expect(row.ok,`${row.f}->${row.t}`).toBe(canTransition(row.f as OperationStatus,row.t as OperationStatus));
 });
 it("backfills every legacy row to expired so none holds open capacity, and the open-operation index holds",async()=>{
  // Legacy rows predate 043; the real runner then applies 043 (recording the
  // environment in the same transaction, Ruling 40), 044 and 045.
  const db=new PGlite();dbs.push(db);
  await db.exec("create role anon; create role authenticated;");
  const run=(stopBefore:string)=>runMigrations({client:db,migrationsDirectory:fileURLToPath(new URL("../migrations/",import.meta.url)),deploymentEnv:"staging",executeScript:(sql:string)=>db.exec(sql),stopBefore});
  await run("043");
  const a=await customer(db),b=await customer(db);
  const oldA=await legacyIntent(db,a,"2026-10-01T00:00:00Z"),newA=await legacyIntent(db,a,"2026-10-02T00:00:00Z"),onlyB=await legacyIntent(db,b,"2026-10-01T00:00:00Z");
  await run("046");
  expect((await db.query("select filename from peragus_schema_migrations where filename>='043' order by 1")).rows).toEqual([{filename:"043_money_environment_guard.sql"},{filename:"044_invite_email_idempotency_by_environment.sql"},{filename:MIGRATION}]);
  const rows=(await db.query<{id:string;status:string}>("select id,status from peragus_customer_purchase_intents")).rows;
  expect(Object.fromEntries(rows.map(r=>[r.id,r.status]))).toEqual({[oldA]:"expired",[newA]:"expired",[onlyB]:"expired"});
  const events=(await db.query<{purchase_id:string;from_status:string|null;to_status:string;actor:string}>("select purchase_id,from_status,to_status,actor from peragus_operation_status_events order by to_status")).rows;
  expect(events).toHaveLength(3);expect(events.every(e=>e.actor==="system:migration_045" && e.from_status===null && e.to_status==="expired")).toBe(true);
 });
 it("keeps the status event log append-only and environment-guarded",async()=>{
  const db=await migrated(),id=await customer(db);
  await db.query("insert into peragus_database_environment(environment) values('test')");
  const purchase=await legacyIntent(db,id,new Date().toISOString());
  await expect(db.query("insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment) values($1,$2,'accepted','awaiting_pix','system','synthetic','live')",[purchase,id])).rejects.toThrow("ENVIRONMENT_MISMATCH");
  await db.query("insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment) values($1,$2,'accepted','awaiting_pix','system','synthetic','test')",[purchase,id]);
  await expect(db.query("update peragus_operation_status_events set reason='changed'")).rejects.toThrow("OPERATION_STATUS_EVENTS_APPEND_ONLY");
  await expect(db.query("delete from peragus_operation_status_events")).rejects.toThrow("OPERATION_STATUS_EVENTS_APPEND_ONLY");
  const r=await db.query("select relrowsecurity,has_table_privilege('anon','peragus_operation_status_events','SELECT') a from pg_class where relname='peragus_operation_status_events'");
  expect(r.rows[0]).toEqual({relrowsecurity:true,a:false});
 });
 it("only creates purchase intents at accepted",async()=>{
  const db=await migrated(),id=await customer(db);
  await db.query("insert into peragus_database_environment(environment) values('test')");
  const purchase=await legacyIntent(db,id,new Date().toISOString());
  expect((await db.query("select status from peragus_customer_purchase_intents where id=$1",[purchase])).rows).toEqual([{status:"accepted"}]);
  await expect(db.query("update peragus_customer_purchase_intents set status='quoted' where id=$1",[purchase])).rejects.toThrow("OPERATION_INVALID_TRANSITION");
  await expect(db.query("update peragus_customer_purchase_intents set status='bogus' where id=$1",[purchase])).rejects.toThrow();
  await expect(db.query(`insert into peragus_customer_purchase_intents(id,customer_id,request_id,quote_id,provider_customer_id,source_amount_brl,estimated_target_amount_usdt,quote_snapshot,wallet_address,wallet_verified_at,evidence_snapshot,environment,wallet_proof_network,status)
   values($1,$2,$3,$4,'ozav_cus_synthetic','500.00','100.000000','{}',$5,now(),'{}','test','solana:devnet','awaiting_pix')`,[randomUUID(),id,randomUUID(),randomUUID(),Keypair.generate().publicKey.toBase58()])).rejects.toThrow("OPERATION_INVALID_TRANSITION");
 });
 it("locks only real columns: every immutability trigger argument is a column, and an unknown one fails loudly",async()=>{
  const db=await migrated(),id=await customer(db);
  const t=await db.query<{a:string}>("select encode(tgargs,'escape') a from pg_trigger where tgname='peragus_purchase_financial_immutable' and tgrelid='peragus_customer_purchase_intents'::regclass");
  const locked=t.rows[0]!.a.split("\\000").filter(Boolean);
  expect(locked).toEqual(expect.arrayContaining(["quote_id","source_amount_brl","estimated_target_amount_usdt","wallet_address"]));
  const cols=(await db.query<{c:string}>("select column_name c from information_schema.columns where table_name='peragus_customer_purchase_intents'")).rows.map(r=>r.c);
  for(const column of locked)expect(cols,column).toContain(column);
  await db.query("insert into peragus_database_environment(environment) values('test')");
  const purchase=await legacyIntent(db,id,new Date().toISOString());
  await db.exec("create trigger zz_bogus_lock before update on peragus_customer_purchase_intents for each row execute function peragus_purchase_financial_immutable('no_such_column')");
  await expect(db.query("update peragus_customer_purchase_intents set status='expired' where id=$1",[purchase])).rejects.toThrow("PURCHASE_LOCKED_COLUMN_UNKNOWN: no_such_column");
 });
});
