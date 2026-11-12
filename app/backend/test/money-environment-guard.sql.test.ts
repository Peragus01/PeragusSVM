import {randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import {Keypair} from "@solana/web3.js";
import {afterEach,describe,expect,it,vi} from "vitest";
import type {Pool} from "pg";
import {PostgresCustomerWalletRepository} from "../src/repositories/postgres-customer-wallet.js";
import {databaseEnvironmentFor,recordDatabaseEnvironment} from "../scripts/lib/database-environment.mjs";

const GUARD="043_money_environment_guard.sql";
const GUARDED=["peragus_customer_wallet_challenges","peragus_customer_wallets","peragus_customer_indicative_quotes",
 "peragus_customer_purchase_intents","peragus_customer_sandbox_pix","peragus_customer_withdrawal_requests",
 "peragus_withdrawal_operator_approvals","peragus_sandbox_withdrawal_executions","peragus_customer_refund_requests",
 "peragus_customer_reconciliation",
 // customer onboarding and invitation tables (Ruling 9)
 "peragus_ozav_sandbox_customer_links","peragus_customer_webhook_events","peragus_individual_onboarding_drafts",
 "peragus_customer_terms_sessions","peragus_customer_onboarding_submissions","peragus_customer_verifications",
 "peragus_customer_screenings","peragus_pilot_invites","peragus_onboarding_email_outbox",
 "peragus_customer_document_uploads","peragus_invite_email_outbox",
 // purchase operation status log (045)
 "peragus_operation_status_events",
 // operator refund decisions (048)
 "peragus_operator_refund_decisions"];
const NETWORK_COLUMNS:Record<string,string>={peragus_customer_wallets:"network",
 peragus_customer_purchase_intents:"wallet_proof_network",peragus_customer_withdrawal_requests:"proof_network"};
vi.setConfig({testTimeout:60000});
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
async function applyGuard(db:PGlite){await db.exec(await readFile(new URL(`../migrations/${GUARD}`,import.meta.url),"utf8"));}
async function customer(db:PGlite){
 const id=randomUUID();
 await db.query("insert into peragus_customers(id,owner_user_id,customer_type,display_name) values($1,$2,'pf','Synthetic name')",[id,randomUUID()]);
 return id;
}
const wallet=(db:PGlite,id:string,environment:string,network:string)=>db.query(
 `insert into peragus_customer_wallets(customer_id,environment,network,wallet_address,proof_challenge_id,proof_message,proof_signature,verified_at)
  values($1,$2,$3,$4,$5,'synthetic message','synthetic signature',now())`,[id,environment,network,Keypair.generate().publicKey.toBase58(),randomUUID()]);
const challenge=(db:PGlite,id:string,environment:string)=>db.query(
 `insert into peragus_customer_wallet_challenges(customer_id,id,environment,wallet_address,nonce,issued_at,expires_at)
  values($1,$2,$3,$4,$5,now(),now()+interval '1 minute')`,[id,randomUUID(),environment,Keypair.generate().publicKey.toBase58(),randomUUID()]);

describe("money environment guard (migration 043)",()=>{
 it("rejects inserts before the database environment is recorded",async()=>{
  const db=await migrated(),id=await customer(db);
  await expect(wallet(db,id,"test","solana:devnet")).rejects.toThrow("ENVIRONMENT_MISMATCH");
  await expect(challenge(db,id,"test")).rejects.toThrow("ENVIRONMENT_MISMATCH");
 });

 it("accepts test rows in a test database and rejects live rows",async()=>{
  const db=await migrated(),id=await customer(db),other=await customer(db);
  await db.query("insert into peragus_database_environment(environment) values('test')");
  await wallet(db,id,"test","solana:devnet");
  await challenge(db,id,"test");
  await expect(wallet(db,other,"live","solana:mainnet")).rejects.toThrow("ENVIRONMENT_MISMATCH");
  await expect(challenge(db,other,"live")).rejects.toThrow("ENVIRONMENT_MISMATCH");
  await expect(db.query("update peragus_customer_wallet_challenges set environment='live' where customer_id=$1",[id])).rejects.toThrow("ENVIRONMENT_MISMATCH");
 });

 it("accepts live+mainnet in a live database and rejects live+devnet",async()=>{
  const db=await migrated(),id=await customer(db),other=await customer(db);
  await db.query("insert into peragus_database_environment(environment) values('live')");
  await wallet(db,id,"live","solana:mainnet");
  await challenge(db,id,"live");
  await expect(wallet(db,other,"live","solana:devnet")).rejects.toThrow(/check constraint/);
  await expect(wallet(db,other,"test","solana:devnet")).rejects.toThrow("ENVIRONMENT_MISMATCH");
  await expect(wallet(db,other,"live","solana")).rejects.toThrow(/check constraint/);
 });

 it("existing rows created as test remain readable",async()=>{
  const db=await migrated(GUARD),id=await customer(db);
  // Pre-043 inserts relied on the defaults.
  await db.query(`insert into peragus_customer_wallets(customer_id,wallet_address,proof_challenge_id,proof_message,proof_signature,verified_at)
   values($1,$2,$3,'synthetic message','synthetic signature',now())`,[id,Keypair.generate().publicKey.toBase58(),randomUUID()]);
  await db.query("insert into peragus_customer_wallet_challenges(customer_id,id,wallet_address,nonce,issued_at,expires_at) values($1,$2,$3,$4,now(),now()+interval '1 minute')",[id,randomUUID(),Keypair.generate().publicKey.toBase58(),randomUUID()]);
  await applyGuard(db);
  await db.query("insert into peragus_database_environment(environment) values('test')");
  expect((await db.query("select environment,network from peragus_customer_wallets where customer_id=$1",[id])).rows).toEqual([{environment:"test",network:"solana:devnet"}]);
  expect((await db.query("select environment from peragus_customer_wallet_challenges where customer_id=$1",[id])).rows).toEqual([{environment:"test"}]);
  await db.query("update peragus_customer_wallet_challenges set consumed_at=now() where customer_id=$1",[id]);
 });

 it("removes environment and network defaults and guards every money table",async()=>{
  const db=await migrated();
  const defaults=await db.query<{t:string;c:string}>(`select table_name t,column_name c from information_schema.columns
   where table_name=any($1) and column_name in ('environment','network','wallet_proof_network','proof_network') and column_default is not null
   and not (table_name='peragus_sandbox_withdrawal_executions' and column_name='network')`,[GUARDED]);
  expect(defaults.rows).toEqual([]);
  const triggers=await db.query<{t:string}>(`select c.relname t from pg_trigger g join pg_class c on c.oid=g.tgrelid
   join pg_proc p on p.oid=g.tgfoid where p.proname='peragus_enforce_row_environment' and not g.tgisinternal order by 1`);
  expect(triggers.rows.map(r=>r.t)).toEqual([...GUARDED].sort());
 });

 it("keeps the recorded database environment immutable",async()=>{
  const db=await migrated();
  await db.query("insert into peragus_database_environment(environment) values('test')");
  await expect(db.query("insert into peragus_database_environment(environment) values('live')")).rejects.toThrow();
  await expect(db.query("update peragus_database_environment set environment='live'")).rejects.toThrow("DATABASE_ENVIRONMENT_IMMUTABLE");
  await expect(db.query("delete from peragus_database_environment")).rejects.toThrow("DATABASE_ENVIRONMENT_IMMUTABLE");
  await expect(db.query("truncate peragus_database_environment")).rejects.toThrow("DATABASE_ENVIRONMENT_IMMUTABLE");
  expect((await db.query("select environment from peragus_database_environment")).rows).toEqual([{environment:"test"}]);
 });

 it("catalog: no guarded table keeps a test-only CHECK; pairing checks and triggers exist",async()=>{
  const db=await migrated();
  const checks=await db.query<{t:string;def:string}>(`select c.relname t,pg_get_constraintdef(con.oid) def from pg_constraint con
   join pg_class c on c.oid=con.conrelid where con.contype='c' and c.relname=any($1)`,[GUARDED]);
  const testOnly=checks.rows.filter(r=>/environment/.test(r.def) && /'test'/.test(r.def) && !/'live'/.test(r.def));
  expect(testOnly).toEqual([]);
  for(const t of GUARDED){
   const defs=checks.rows.filter(r=>r.t===t).map(r=>r.def);
   expect(defs.some(d=>/environment/.test(d) && /'test'/.test(d) && /'live'/.test(d)),t).toBe(true);
   const net=NETWORK_COLUMNS[t];
   if(net)expect(defs.some(d=>d.includes(net) && /'test'/.test(d) && /'solana:devnet'/.test(d) && /'live'/.test(d) && /'solana:mainnet'/.test(d)),t).toBe(true);
  }
  const triggers=await db.query<{t:string}>(`select c.relname t from pg_trigger g join pg_class c on c.oid=g.tgrelid
   join pg_proc p on p.oid=g.tgfoid where p.proname='peragus_enforce_row_environment' and not g.tgisinternal
   and (g.tgtype & 1)=1 and (g.tgtype & 2)=2 and (g.tgtype & 4)=4 and (g.tgtype & 16)=16`);
  expect(triggers.rows.map(r=>r.t).sort()).toEqual([...GUARDED].sort());
 });

 it("accepts live onboarding rows in a live database",async()=>{
  const db=await migrated(),id=await customer(db);
  await db.query("insert into peragus_database_environment(environment) values('live')");
  await db.query("insert into peragus_individual_onboarding_drafts(customer_id,encrypted_payload,environment) values($1,'{}','live')",[id]);
  await expect(db.query("insert into peragus_customer_verifications(customer_id,provider_customer_id,environment) values($1,'ozav_cus_synthetic','test')",[id])).rejects.toThrow("ENVIRONMENT_MISMATCH");
 });
});

describe("Postgres repositories write the money mode they were built with",()=>{
 const pool=(db:PGlite)=>({query:async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};},
  connect:async()=>({query:async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};},release:()=>{}})}) as unknown as Pool;
 for(const [mode,network] of [["live","solana:mainnet"],["test","solana:devnet"]] as const){
  it(`binds a ${mode} wallet on ${network} in a ${mode} database`,async()=>{
   const db=await migrated(),id=await customer(db),repo=new PostgresCustomerWalletRepository(pool(db),mode);
   await db.query("insert into peragus_database_environment(environment) values($1)",[mode]);
   const now=new Date(),c={id:randomUUID(),customerId:id,walletAddress:Keypair.generate().publicKey.toBase58(),nonce:randomUUID(),
    issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60000).toISOString(),consumedAt:null};
   await repo.issue(c);
   expect((await repo.challenge(id))?.id).toBe(c.id);
   await repo.consume(c,new Date(now.getTime()+1000),"synthetic signature","synthetic proof message");
   expect(await repo.find(id)).toMatchObject({walletAddress:c.walletAddress});
   expect((await db.query("select environment,network from peragus_customer_wallets where customer_id=$1",[id])).rows).toEqual([{environment:mode,network}]);
   const wrong=new PostgresCustomerWalletRepository(pool(db),mode==="live"?"test":"live");
   expect(await wrong.find(id)).toBeNull();
  });
 }
});

describe("migrate.mjs database environment step",()=>{
 const client=(db:PGlite)=>({query:(sql:string,params?:unknown[])=>db.query(sql,params)});
 it("derives live from production, test from staging, and rejects anything else",()=>{
  expect(databaseEnvironmentFor("production")).toBe("live");
  expect(databaseEnvironmentFor("staging")).toBe("test");
  for(const bad of [undefined,"","development","Production","live"])
   expect(()=>databaseEnvironmentFor(bad)).toThrow("DATABASE_DEPLOYMENT_ENV_INVALID");
 });
 it("records the environment once and accepts the same value again",async()=>{
  const db=await migrated();
  expect(await recordDatabaseEnvironment(client(db),"staging")).toBe("test");
  expect(await recordDatabaseEnvironment(client(db),"staging")).toBe("test");
  expect((await db.query("select environment from peragus_database_environment")).rows).toEqual([{environment:"test"}]);
 });
 it("aborts with DATABASE_ENVIRONMENT_CONFLICT when the recorded value differs",async()=>{
  const db=await migrated();
  await recordDatabaseEnvironment(client(db),"staging");
  await expect(recordDatabaseEnvironment(client(db),"production")).rejects.toThrow("DATABASE_ENVIRONMENT_CONFLICT");
  expect((await db.query("select environment from peragus_database_environment")).rows).toEqual([{environment:"test"}]);
 });
 it("refuses an unset deployment without recording anything",async()=>{
  const db=await migrated();
  await expect(recordDatabaseEnvironment(client(db),undefined)).rejects.toThrow("DATABASE_DEPLOYMENT_ENV_INVALID");
  expect((await db.query("select count(*)::int n from peragus_database_environment")).rows).toEqual([{n:0}]);
 });
});
