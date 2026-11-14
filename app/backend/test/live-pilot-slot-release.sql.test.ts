import {randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import {Keypair} from "@solana/web3.js";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";

// Ruling 27: in live the global pilot slot (one unresolved execution) is released by the database
// when the operation reaches delivered_verified, refunded or a terminal failure (migration 050).
vi.setConfig({testTimeout:60000,hookTimeout:60000});
type Mode="live"|"test";
const dbs:Partial<Record<Mode,PGlite>>={};
async function migrated(mode:Mode){
 const db=new PGlite();
 await db.exec("create role anon; create role authenticated;");
 const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),"utf8"));
 await db.query("insert into peragus_database_environment(environment) values($1)",[mode]);
 return db;
}
beforeAll(async()=>{dbs.live=await migrated("live");dbs.test=await migrated("test");});
afterAll(async()=>{await Promise.all(Object.values(dbs).map(db=>db!.close()));});
beforeEach(async()=>{for(const db of Object.values(dbs))await db!.query("truncate peragus_sandbox_withdrawal_executions cascade");});

/**
 * One operation with an attempted execution, written as stored evidence: the rows are inserted
 * with triggers and foreign keys off (session_replication_role=replica) so the test needs no
 * quote/Pix/approval chain. Column CHECK constraints and unique indexes still apply, and every
 * status change below runs with all triggers on.
 */
async function operation(mode:Mode,status:string){
 const db=dbs[mode]!,customer=randomUUID(),purchase=randomUUID(),withdrawal=randomUUID(),execution=randomUUID(),wallet=Keypair.generate().publicKey.toBase58();
 const network=mode==="live"?"solana:mainnet":"solana:devnet",provider="ozav_cus_"+customer.replaceAll("-","");
 await db.query("insert into peragus_customers(id,owner_user_id,customer_type,display_name) values($1,$2,'pf','Synthetic name')",[customer,randomUUID()]);
 await db.exec("set session_replication_role=replica");
 try{
  await db.query(`insert into peragus_customer_purchase_intents(id,customer_id,request_id,quote_id,environment,provider_customer_id,source_amount_brl,
   estimated_target_amount_usdt,quote_snapshot,wallet_address,wallet_proof_network,wallet_verified_at,evidence_snapshot,status,locked_usdt_amount)
   values($1,$2,$3,$4,$5,$6,1000,200,'{}',$7,$8,now(),'{}',$9,200)`,[purchase,customer,randomUUID(),randomUUID(),mode,provider,wallet,network,status]);
  await db.query(`insert into peragus_customer_withdrawal_requests(id,customer_id,request_id,pix_id,purchase_intent_id,environment,provider_customer_id,provider_wallet_id,
   provider_transfer_id,amount_usdt,wallet_address,proof_network,wallet_verified_at,evidence_snapshot)
   values($1,$2,$3,$4,$5,$6,$7,'ozav_wal_example',$8,200,$9,$10,now(),'{}')`,[withdrawal,customer,randomUUID(),randomUUID(),purchase,mode,provider,"ozav_tr_"+randomUUID().replaceAll("-",""),wallet,network]);
 }finally{await db.exec("set session_replication_role=origin");}
 const reserve=async()=>{
  await db.exec("set session_replication_role=replica");
  try{
   await db.query(`insert into peragus_sandbox_withdrawal_executions(id,withdrawal_request_id,customer_id,approval_id,approver_id,operator_id,request_id,pix_id,
    provider_customer_id,provider_wallet_id,provider_quote_id,funding_transfer_id,amount_brl,amount_usdt,send_amount_usdt,wallet_address,verified_at,idempotency_key,create_attempted,environment)
    values($1,$2,$3,$4,$5,$5,$6,$7,$8,'ozav_wal_example','ozav_q_example','ozav_tr_funding',1000,200,200,$9,now(),$10,true,$11)`,
    [execution,withdrawal,customer,randomUUID(),randomUUID(),randomUUID(),randomUUID(),provider,wallet,"peragus-send-"+execution,mode]);
  }finally{await db.exec("set session_replication_role=origin");}
 };
 const move=(to:string)=>db.query("update peragus_customer_purchase_intents set status=$2 where id=$1",[purchase,to]);
 const released=async()=>(await db.query<{slot_released_at:Date|null}>("select slot_released_at from peragus_sandbox_withdrawal_executions where id=$1",[execution])).rows[0]!.slot_released_at!==null;
 return{db,purchase,execution,reserve,move,released};
}

describe("live pilot slot release (migration 050)",()=>{
 it("holds the single slot while the live operation is unresolved",async()=>{
  const first=await operation("live","sent"),second=await operation("live","approved");
  await first.reserve();
  await expect(second.reserve()).rejects.toThrow(/peragus_one_unresolved_sandbox_withdrawal|unique/i);
  // Review is not final: the slot stays held.
  await first.move("needs_review");
  expect(await first.released()).toBe(false);
  await expect(second.reserve()).rejects.toThrow();
 });
 it("releases the slot when the live operation reaches delivered_verified",async()=>{
  const first=await operation("live","sent"),second=await operation("live","approved");
  await first.reserve();
  await first.move("delivered_verified");
  expect(await first.released()).toBe(true);
  await second.reserve();
  expect(await second.released()).toBe(false);
 });
 it("releases the slot when the live operation is refunded or fails terminally",async()=>{
  for(const path of [["needs_review","refund_pending","refunded"],["needs_review","failed"]]){
   await dbs.live!.query("truncate peragus_sandbox_withdrawal_executions cascade");
   const first=await operation("live","sending"),second=await operation("live","approved");
   await first.reserve();
   for(const step of path.slice(0,-1)){await first.move(step);expect(await first.released()).toBe(false);}
   await first.move(path.at(-1)!);
   expect(await first.released()).toBe(true);
   await second.reserve();
  }
  // expired is terminal too (an operation that never reached a send but holds a reserved execution).
  await dbs.live!.query("truncate peragus_sandbox_withdrawal_executions cascade");
  const expiring=await operation("live","awaiting_pix");
  await expiring.reserve();await expiring.move("expired");
  expect(await expiring.released()).toBe(true);
 });
 it("never releases in test mode: the sandbox closure stays the only way out",async()=>{
  const first=await operation("test","sent"),second=await operation("test","approved");
  await first.reserve();
  await first.move("delivered_verified");
  expect(await first.released()).toBe(false);
  await expect(second.reserve()).rejects.toThrow();
  await expect(first.db.query("update peragus_sandbox_withdrawal_executions set slot_released_at=now() where id=$1",[first.execution])).rejects.toThrow(/peragus_execution_slot_release_live_only/);
 });
});
