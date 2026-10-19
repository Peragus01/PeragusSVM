import {generateKeyPairSync,randomUUID,sign} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {PublicKey} from "@solana/web3.js";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PostgresCustomerWalletRepository} from "../src/repositories/postgres-customer-wallet.js";
import {CustomerWalletService,walletProofMessage,canonicalWalletAddress} from "../src/wallets/customer-wallet.js";
const db=new PGlite();let failInsert=false;let connection=Promise.resolve();
const query=async(sql:string,params?:unknown[])=>{
 if(failInsert && sql.includes("insert into peragus_customer_wallets")){failInsert=false;throw new Error("insert unavailable");}
 const r=await db.query(sql,params);return{...r,rowCount:r.rows.length};
};
const pool={query,connect:async()=>{
 const previous=connection;let release!:()=>void;connection=new Promise<void>(resolve=>{release=resolve;});await previous;
 return{query,release};
}} as unknown as Pool;
const customers=new PostgresCustomerRepository(pool),repo=new PostgresCustomerWalletRepository(pool);
let now=new Date();const service=new CustomerWalletService(repo,()=>now);
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");
 const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),"utf8"));
},30000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
async function setup(type:"pf"|"pj"="pf"){
 now=new Date();const owner=randomUUID(),customer=(await customers.createOrGet({ownerUserId:owner,type,displayName:"Test"})).customer;
 const keys=generateKeyPairSync("ed25519"),raw=keys.publicKey.export({format:"der",type:"spki"});
 const address=new PublicKey(raw.subarray(raw.length-32)).toBase58();
 return{owner,customer,keys,address};
}
const signature=(message:string,keys:ReturnType<typeof generateKeyPairSync>)=>sign(null,Buffer.from(message,"utf8"),keys.privateKey).toString("base64");
async function appFor(s:Awaited<ReturnType<typeof setup>>,enabled=true){
 const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return{id:s.owner,email:"private@example.test"};}},...(enabled?{customerWalletService:service}:{})});apps.push(app);return app;
}
const path="/v1/me/wallet",headers={authorization:"Bearer valid"};
describe("authenticated Solana wallet ownership",()=>{
 it("binds a signed test wallet, stores verifiable proof but exposes no signature or private key and never enables operations",async()=>{
  const s=await setup(),app=await appFor(s);expect(await service.read(s.customer.id)).toBeNull();
  const start=await app.inject({method:"POST",url:`${path}/challenge`,headers,payload:{wallet_address:s.address}});
  expect(start.statusCode).toBe(201);expect(start.headers["cache-control"]).toBe("no-store");const challenge=start.json().data;
  expect(challenge.message).toContain("does not authorize payments");expect(challenge).toMatchObject({domain:"peragussvm-staging.up.railway.app",network:"solana:devnet",environment:"test"});
  expect(Date.parse(challenge.expires_at)-now.getTime()).toBe(300000);
  const sig=signature(challenge.message,s.keys);
  const confirm=await app.inject({method:"POST",url:`${path}/confirm`,headers,payload:{challenge_id:challenge.challenge_id,signature_base64:sig}});
  expect(confirm.statusCode).toBe(200);expect(confirm.json().data).toMatchObject({wallet_address:s.address,operations_enabled:false});expect(confirm.body).not.toContain(sig);
  expect((await app.inject({method:"GET",url:path,headers})).json().data.wallet_address).toBe(s.address);
  const proof=await db.query("select proof_message,proof_signature from peragus_customer_wallets where customer_id=$1",[s.customer.id]);expect(proof.rows[0]).toEqual({proof_message:challenge.message,proof_signature:sig});
  expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");expect((await app.inject({method:"POST",url:"/v1/settlements",headers,payload:{}})).statusCode).toBe(403);
 });
 it("rejects replay and silently replacing an existing binding",async()=>{
  const s=await setup(),c=await service.start(s.customer.id,s.address),sig=signature(c.message,s.keys);
  await service.confirm(s.customer.id,c.challenge_id,sig);
  await expect(service.confirm(s.customer.id,c.challenge_id,sig)).rejects.toThrow("WALLET_CHALLENGE_USED");
  await expect(service.start(s.customer.id,(await setup()).address)).rejects.toThrow("WALLET_ALREADY_LINKED");
 });
 it("rejects expired challenges at the boundary and challenges dated in the future",async()=>{
  const s=await setup(),c=await service.start(s.customer.id,s.address);now=new Date(c.expires_at);
  await expect(service.confirm(s.customer.id,c.challenge_id,signature(c.message,s.keys))).rejects.toThrow("WALLET_CHALLENGE_EXPIRED");
  now=new Date(Date.parse(c.expires_at)-300001);await expect(service.confirm(s.customer.id,c.challenge_id,signature(c.message,s.keys))).rejects.toThrow("WALLET_CHALLENGE_EXPIRED");
 });
 it("checks expiry again on the database clock when consuming, even if the API validation time is stale",async()=>{
  const s=await setup(),past=new Date(Date.now()-600000),stale=new CustomerWalletService(repo,()=>past);
  const c=await stale.start(s.customer.id,s.address);
  await expect(stale.confirm(s.customer.id,c.challenge_id,signature(c.message,s.keys))).rejects.toThrow("WALLET_CHALLENGE_INVALID");
  expect(await stale.read(s.customer.id)).toBeNull();
 });
 it("binds signatures to the exact domain, nonce, message, address and authenticated customer",async()=>{
  const s=await setup(),other=await setup(),c=await service.start(s.customer.id,s.address);
  for(const message of [c.message.replace("peragussvm-staging.up.railway.app","evil.example"),c.message+"\n",c.message.replace("Nonce:","Other Nonce:"),c.message.replace(s.customer.id,other.customer.id)])await expect(service.confirm(s.customer.id,c.challenge_id,signature(message,s.keys))).rejects.toThrow("WALLET_SIGNATURE_INVALID");
  await expect(service.confirm(s.customer.id,c.challenge_id,signature(c.message,other.keys))).rejects.toThrow("WALLET_SIGNATURE_INVALID");
  await expect(service.confirm(other.customer.id,c.challenge_id,signature(c.message,s.keys))).rejects.toThrow("WALLET_CHALLENGE_INVALID");
  expect(await service.read(s.customer.id)).toBeNull();
 });
 it("invalidates old challenges on a new issue and refuses noncanonical or malformed signatures",async()=>{
  const s=await setup(),old=await service.start(s.customer.id,s.address),current=await service.start(s.customer.id,s.address);
  await expect(service.confirm(s.customer.id,old.challenge_id,signature(old.message,s.keys))).rejects.toThrow("WALLET_CHALLENGE_INVALID");
  for(const value of ["not-base64",Buffer.alloc(64).toString("base64"),signature(current.message,s.keys).replace(/=$/," ")])await expect(service.confirm(s.customer.id,current.challenge_id,value)).rejects.toThrow("WALLET_SIGNATURE_INVALID");
  await service.confirm(s.customer.id,current.challenge_id,signature(current.message,s.keys));
 });
 it("refuses invalid, noncanonical, zero and off-curve program addresses",async()=>{
  const [pda]=PublicKey.findProgramAddressSync([Buffer.from("proof")],new PublicKey("11111111111111111111111111111111"));
  for(const address of ["invalid","11111111111111111111111111111111",pda.toBase58()," "+(await setup()).address])expect(()=>canonicalWalletAddress(address)).toThrow("WALLET_ADDRESS_INVALID");
 });
 it("does not allow one proven wallet to move to another customer",async()=>{
  const s=await setup(),other=await setup();const a=await service.start(s.customer.id,s.address);await service.confirm(s.customer.id,a.challenge_id,signature(a.message,s.keys));
  const b=await service.start(other.customer.id,s.address);await expect(service.confirm(other.customer.id,b.challenge_id,signature(b.message,s.keys))).rejects.toThrow("WALLET_BINDING_CONFLICT");
  expect(await service.read(other.customer.id)).toBeNull();expect((await repo.challenge(other.customer.id))?.consumedAt).toBeNull();
 });
 it("rolls back challenge consumption when wallet persistence fails, then safely retries",async()=>{
  const s=await setup(),c=await service.start(s.customer.id,s.address),sig=signature(c.message,s.keys);failInsert=true;
  await expect(service.confirm(s.customer.id,c.challenge_id,sig)).rejects.toThrow("insert unavailable");
  expect((await repo.challenge(s.customer.id))?.consumedAt).toBeNull();expect(await service.read(s.customer.id)).toBeNull();await service.confirm(s.customer.id,c.challenge_id,sig);
 });
 it("allows only one confirmation to consume a challenge under racing calls",async()=>{
  const s=await setup(),c=await service.start(s.customer.id,s.address),sig=signature(c.message,s.keys);
  const results=await Promise.allSettled([service.confirm(s.customer.id,c.challenge_id,sig),service.confirm(s.customer.id,c.challenge_id,sig)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  expect((await db.query("select * from peragus_customer_wallets where customer_id=$1",[s.customer.id])).rows).toHaveLength(1);
 });
 it("does not consume a stale challenge after another issue has replaced it",async()=>{
  const s=await setup();await service.start(s.customer.id,s.address);const old=(await repo.challenge(s.customer.id))!;const sig=signature(walletProofMessage(old),s.keys);await service.start(s.customer.id,s.address);
  await expect(repo.consume(old,now,sig)).rejects.toThrow("WALLET_CHALLENGE_INVALID");expect(await service.read(s.customer.id)).toBeNull();
 });
 it("enforces authentication, PF, suspension, feature gates, strict payloads and private parse errors",async()=>{
  const s=await setup(),pj=await setup("pj"),app=await appFor(s);
  expect((await app.inject({method:"GET",url:path})).statusCode).toBe(401);
  expect((await (await appFor(s,false)).inject({method:"GET",url:path,headers})).statusCode).toBe(503);
  expect((await (await appFor(pj)).inject({method:"GET",url:path,headers})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:`${path}/challenge`,headers,payload:{wallet_address:s.address,customer_id:randomUUID()}})).statusCode).toBe(400);
  expect((await app.inject({method:"GET",url:`${path}?customer_id=another`,headers})).statusCode).toBe(400);
  const malformed=await app.inject({method:"POST",url:`${path}/confirm`,headers:{...headers,"content-type":"application/json"},payload:'{"signature":"private",'});expect(malformed.statusCode).toBe(400);expect(malformed.body).not.toContain("private");
  await db.query("update peragus_customers set suspended=true where id=$1",[s.customer.id]);expect((await app.inject({method:"GET",url:path,headers})).statusCode).toBe(403);
 });
 it("stores only test/devnet data with RLS and no browser grants",async()=>{
  for(const table of ["peragus_customer_wallets","peragus_customer_wallet_challenges"]){
   const r=await db.query(`select relrowsecurity,has_table_privilege('anon',$1,'SELECT') as anon_select,has_table_privilege('authenticated',$1,'INSERT') as auth_insert from pg_class where relname=$1`,[table]);expect(r.rows[0]).toEqual({relrowsecurity:true,anon_select:false,auth_insert:false});
  }
  const s=await setup(),c=await service.start(s.customer.id,s.address);await service.confirm(s.customer.id,c.challenge_id,signature(c.message,s.keys));
  await expect(db.query("update peragus_customer_wallets set environment='live' where customer_id=$1",[s.customer.id])).rejects.toThrow();
  await expect(db.query("update peragus_customer_wallets set network='solana:mainnet' where customer_id=$1",[s.customer.id])).rejects.toThrow();
  await expect(db.query("update peragus_customer_wallet_challenges set expires_at=issued_at+interval '6 minutes' where customer_id=$1",[s.customer.id])).rejects.toThrow();
 });
});
