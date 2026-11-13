import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {PGlite} from "@electric-sql/pglite";
import {Keypair} from "@solana/web3.js";
import {afterEach,describe,expect,it,vi} from "vitest";
import {listMigrationFilenames,runMigrations} from "../scripts/lib/migration-runner.mjs";

vi.setConfig({testTimeout:120000});
const migrationsDirectory=fileURLToPath(new URL("../migrations/",import.meta.url));
const dbs:PGlite[]=[];
afterEach(async()=>{await Promise.all(dbs.splice(0).map(db=>db.close()));});

function runner(db:PGlite,deploymentEnv:string,stopBefore?:string){
 return runMigrations({client:db,migrationsDirectory,deploymentEnv,executeScript:(sql:string)=>db.exec(sql),stopBefore}) as Promise<{appliedCount:number;environment:string|null}>;
}

// Rows written by the app before 043 existed (every money table was test-only then).
async function seedPre043(db:PGlite){
 const customer=randomUUID(),quote=randomUUID(),purchase=randomUUID(),bare=randomUUID();
 await db.query("insert into peragus_customers(id,owner_user_id,customer_type,display_name) values($1,$2,'pf','Synthetic name')",[customer,randomUUID()]);
 // Fixture only: skip the onboarding foreign keys behind the quote.
 await db.exec("set session_replication_role=replica");
 try{
  await db.query(`insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl,create_attempted,provider_quote_id,observation)
   values($1,$2,$3,'ozav_cus_synthetic','500.00',true,'ozav_q_synthetic',$4)`,[quote,customer,randomUUID(),JSON.stringify({target:{amount:"95.123456"}})]);
  await db.query("insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl) values($1,$2,$3,'ozav_cus_synthetic','500.00')",[bare,customer,randomUUID()]);
  await db.query(`insert into peragus_customer_purchase_intents(id,customer_id,request_id,quote_id,provider_customer_id,source_amount_brl,estimated_target_amount_usdt,quote_snapshot,wallet_address,wallet_verified_at,evidence_snapshot)
   values($1,$2,$3,$4,'ozav_cus_synthetic','500.00','95.123456','{}',$5,now(),'{}')`,[purchase,customer,randomUUID(),quote,Keypair.generate().publicKey.toBase58()]);
 }finally{await db.exec("set session_replication_role=origin");}
 return {customer,quote,bare,purchase};
}

describe("scripts/lib/migration-runner (Ruling 40)",()=>{
 for(const [deploymentEnv,environment] of [["staging","test"],["production","live"]] as const){
  it(`migrates a database holding pre-043 purchase and quote rows (${deploymentEnv})`,async()=>{
   const db=new PGlite();dbs.push(db);
   await db.exec("create role anon; create role authenticated;");
   const before=await runner(db,deploymentEnv,"043_money_environment_guard.sql");
   expect(before.environment).toBeNull();
   const seeded=await seedPre043(db);

   const result=await runner(db,deploymentEnv);
   const all=await listMigrationFilenames(migrationsDirectory);
   expect(result.environment).toBe(environment);
   expect(before.appliedCount+result.appliedCount).toBe(all.length);
   const applied=(await db.query<{filename:string}>("select filename from peragus_schema_migrations order by filename")).rows.map(r=>r.filename);
   expect(applied).toEqual(all);
   expect((await db.query("select environment from peragus_database_environment")).rows).toEqual([{environment}]);

   // 045: legacy intents expired with an audit event; 046: locked amounts backfilled.
   const p=(await db.query<{status:string;locked_usdt_amount:string}>("select status,locked_usdt_amount::text from peragus_customer_purchase_intents where id=$1",[seeded.purchase])).rows[0];
   expect(p).toEqual({status:"expired",locked_usdt_amount:"95.123456"});
   const events=(await db.query<{to_status:string;actor:string}>("select to_status,actor from peragus_operation_status_events where purchase_id=$1",[seeded.purchase])).rows;
   expect(events).toEqual([{to_status:"expired",actor:"system:migration_045"}]);
   const quotes=(await db.query<{id:string;locked_usdt_amount:string|null}>("select id,locked_usdt_amount::text from peragus_customer_indicative_quotes")).rows;
   expect(Object.fromEntries(quotes.map(q=>[q.id,q.locked_usdt_amount]))).toEqual({[seeded.quote]:"95.123456",[seeded.bare]:null});

   // Re-running is a no-op and keeps the recorded environment.
   expect(await runner(db,deploymentEnv)).toEqual({appliedCount:0,environment});
   await expect(runner(db,deploymentEnv==="staging"?"production":"staging")).rejects.toThrow("DATABASE_ENVIRONMENT_CONFLICT");
  });
 }

 it("records the environment inside the 043 transaction, before 044 runs",async()=>{
  const db=new PGlite();dbs.push(db);
  await db.exec("create role anon; create role authenticated;");
  await runner(db,"staging","044_invite_email_idempotency_by_environment.sql");
  expect((await db.query("select environment from peragus_database_environment")).rows).toEqual([{environment:"test"}]);
 });

 it("refuses an unknown deployment before touching the database",async()=>{
  const db=new PGlite();dbs.push(db);
  await expect(runner(db,"development")).rejects.toThrow("DATABASE_DEPLOYMENT_ENV_INVALID");
  expect((await db.query("select to_regclass('peragus_schema_migrations') r")).rows).toEqual([{r:null}]);
 });
});
