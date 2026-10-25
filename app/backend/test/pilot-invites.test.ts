import {randomUUID,createHash} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import type {Pool} from "pg";
import {beforeAll,beforeEach,afterAll,describe,it,expect} from "vitest";
import {buildApp} from "../src/app.js";
import {AuthenticationError} from "../src/auth/customer-access.js";
import {PostgresCustomerRepository} from "../src/repositories/postgres-customer-repository.js";
import {PilotInviteService} from "../src/invites/pilot-invites.js";
const db=new PGlite();
const pool={query:async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length};}} as unknown as Pool;
const customers=new PostgresCustomerRepository(pool),apps:Awaited<ReturnType<typeof buildApp>>[]=[];
const operator={id:randomUUID(),assuranceLevel:"aal2" as const,email:"operator@example.test"},reason="Operador autoriza entrada no piloto fechado.";
const service=(enabled=true)=>new PilotInviteService(pool,new Set([operator.id]),enabled);
let seeded:number;
beforeAll(async()=>{
 await db.exec("create role anon;create role authenticated;alter default privileges grant all on tables to anon,authenticated;");
 const dir=new URL("../migrations/",import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort()){
  if(f.startsWith("030_")){
   for(let n=0;n<2;n++)await customers.createOrGet({ownerUserId:randomUUID(),type:"pf",displayName:"Existing pilot customer"});
  }
  await db.exec(await readFile(new URL(f,dir),"utf8"));
 }
 seeded=Number((await db.query<{n:number}>("select count(*)::int as n from peragus_pilot_invite_slots where admitted_user_id is not null")).rows[0]!.n);
},30000);
beforeEach(async()=>{
 await db.exec("truncate peragus_customers,peragus_pilot_invites,peragus_pilot_invite_slots,peragus_pilot_invite_rate_limits cascade;insert into peragus_pilot_invite_slots(slot) select generate_series(1,5)");
});
afterAll(async()=>{await Promise.all(apps.map(app=>app.close()));await db.close();});
async function appFor(user={id:randomUUID(),email:"verified@example.test"},enabled=true){
 const app=await buildApp({customerAccess:{customers,authenticate:async(token)=>{if(token!=="synthetic")throw new AuthenticationError("INVALID_TOKEN");return user;}},pilotInviteService:service(enabled)});apps.push(app);return app;
}
const headers={authorization:"Bearer synthetic"};
async function issue(target=randomUUID(),request=randomUUID(),hours=24){return service().issue(operator,request,target,hours,reason);}
describe("closed PF pilot invitations",()=>{
 it("counts existing PF profiles in the initial five slots",()=>{expect(seeded).toBe(2);});
 it("returns an unpredictable code once, stores only its hash and does not grant financial approval",async()=>{
  const target=randomUUID(),key=randomUUID(),issued=await issue(target,key);
  expect(issued.code).toMatch(/^pginv_[A-Za-z0-9_-]{43}$/);expect(issued.replayed).toBe(false);
  const row=(await db.query<any>("select * from peragus_pilot_invites")).rows[0];
  expect(row.code_hash).toBe(createHash("sha256").update(issued.code!).digest("hex"));expect(JSON.stringify(row)).not.toContain(issued.code!);
  expect((await customers.findByOwner(target))).toBeNull();
  const replay=await issue(target,key);expect(replay.data.id).toBe(issued.data.id);expect(replay.code).toBeNull();expect(replay.replayed).toBe(true);
  await expect(issue(randomUUID(),key)).rejects.toThrow("PILOT_INVITE_IDEMPOTENCY_CONFLICT");
 });
 it("creates one PF profile and consumes the invitation atomically",async()=>{
  const target=randomUUID(),issued=await issue(target),request=randomUUID(),user={id:target,email:"verified@example.test"};
  const result=await service().redeem(user,request,issued.code!,"Synthetic pilot customer");
  expect(result.data.customer).toMatchObject({type:"pf",verification_status:"draft",operations_enabled:false});
  expect((await service().redeem(user,request,issued.code!,"Synthetic pilot customer")).replayed).toBe(true);
  await expect(service().redeem(user,randomUUID(),issued.code!,"Synthetic pilot customer")).rejects.toThrow("PILOT_INVITE_ALREADY_REDEEMED");
  await expect(service().redeem(user,request,issued.code!,"Changed profile name")).rejects.toThrow("PILOT_INVITE_IDEMPOTENCY_CONFLICT");
  expect((await db.query("select count(*)::int as n from peragus_customers")).rows[0]).toEqual({n:1});
  expect((await db.query("select count(*)::int as n from peragus_pilot_invite_slots where admitted_user_id is not null")).rows[0]).toEqual({n:1});
 });
 it("does not reveal whether a code belongs to another account",async()=>{
  const issued=await issue();const user={id:randomUUID(),email:"other@example.test"};
  for(const code of [issued.code!,"pginv_"+"a".repeat(43)])await expect(service().redeem(user,randomUUID(),code,"Synthetic customer")).rejects.toThrow("PILOT_INVITE_NOT_AVAILABLE");
  expect((await db.query("select count(*)::int as n from peragus_customers")).rows[0]).toEqual({n:0});
 });
 it("enforces five slots under concurrent issuance and retains redeemed seats",async()=>{
  const issued=await Promise.allSettled(Array.from({length:7},()=>issue()));
  const successes=issued.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof issue>>>=>r.status==="fulfilled");
  expect(successes).toHaveLength(5);
  for(const {value} of successes)await service().redeem({id:value.data.target_user_id,email:"verified@example.test"},randomUUID(),value.code!,"Synthetic customer");
  await expect(issue()).rejects.toThrow("PILOT_CAPACITY_UNAVAILABLE");
  await expect(service().revoke(operator,successes[0]!.value.data.id,randomUUID(),reason)).rejects.toThrow("PILOT_INVITE_TERMINAL");
  expect((await db.query("select count(*)::int as n from peragus_customers")).rows[0]).toEqual({n:5});
 });
 it("revokes an unused code idempotently and reuses its slot without restoring it",async()=>{
  const issued=await issue(),key=randomUUID();
  expect((await service().revoke(operator,issued.data.id,key,reason)).replayed).toBe(false);
  expect((await service().revoke(operator,issued.data.id,key,reason)).replayed).toBe(true);
  await expect(service().revoke(operator,issued.data.id,key,reason+" Changed")).rejects.toThrow("PILOT_INVITE_IDEMPOTENCY_CONFLICT");
  await expect(service().redeem({id:issued.data.target_user_id,email:"verified@example.test"},randomUUID(),issued.code!,"Synthetic customer")).rejects.toThrow("PILOT_INVITE_NOT_AVAILABLE");
  const replacement=await issue();expect(replacement.data.slot).toBe(issued.data.slot);expect(replacement.code).not.toBe(issued.code);
 });
 it("rejects expired invitations and replaces them safely",async()=>{
  const target=randomUUID(),id=randomUUID(),code="pginv_"+"b".repeat(43);
  await db.query("insert into peragus_pilot_invites(id,slot,target_user_id,code_hash,operator_user_id,request_id,reason,duration_hours,created_at,expires_at) values($1,1,$2,$3,$4,$5,$6,1,now()-interval '2 hours',now()-interval '1 hour')",[id,target,createHash("sha256").update(code).digest("hex"),operator.id,randomUUID(),reason]);
  await db.query("update peragus_pilot_invite_slots set current_invite_id=$1 where slot=1",[id]);
  await expect(service().redeem({id:target,email:"verified@example.test"},randomUUID(),code,"Synthetic customer")).rejects.toThrow("PILOT_INVITE_NOT_AVAILABLE");
  const replacement=await issue(target);expect(replacement.data.slot).toBe(1);expect(replacement.code).not.toBe(code);
  expect((await service().read(operator,id)).state).toBe("expired");
 });
 it("allows one effective redemption across racing requests",async()=>{
  const target=randomUUID(),issued=await issue(target),user={id:target,email:"verified@example.test"};
  const results=await Promise.allSettled([service().redeem(user,randomUUID(),issued.code!,"Synthetic customer"),service().redeem(user,randomUUID(),issued.code!,"Synthetic customer")]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect((await db.query("select count(*)::int as n from peragus_customers")).rows[0]).toEqual({n:1});
 });
 it("rejects duplicate active invitations for a user without stranding another slot",async()=>{
  const target=randomUUID();await issue(target);
  await expect(issue(target)).rejects.toThrow("PILOT_USER_ALREADY_INVITED");
  expect((await db.query("select count(*)::int as n from peragus_pilot_invite_slots where current_invite_id is not null")).rows[0]).toEqual({n:1});
 });
 it("blocks operators and existing customers as invitation targets",async()=>{
  await expect(issue(operator.id)).rejects.toThrow("PILOT_OPERATOR_NOT_ELIGIBLE");
  const owner=randomUUID();await customers.createOrGet({ownerUserId:owner,type:"pf",displayName:"Existing customer"});
  await expect(issue(owner)).rejects.toThrow("PILOT_CUSTOMER_ALREADY_EXISTS");
 });
 it("closes direct registration while preserving existing profile reads and replay",async()=>{
  const owner=randomUUID(),app=await appFor({id:owner,email:"verified@example.test"},false);
  for(const type of ["pf","pj"]){const denied=await app.inject({method:"POST",url:"/v1/me/customer",headers,payload:{type,display_name:"Synthetic customer"}});expect(denied.statusCode).toBe(403);expect(denied.json().error.code).toBe("PILOT_INVITE_REQUIRED");}
  await customers.createOrGet({ownerUserId:owner,type:"pf",displayName:"Existing customer"});
  const replay=await app.inject({method:"POST",url:"/v1/me/customer",headers,payload:{type:"pf",display_name:"Existing customer"}});expect(replay.statusCode).toBe(200);
  expect((await app.inject({method:"GET",url:"/v1/me",headers})).statusCode).toBe(200);
 });
 it("lets a verified Auth user without a profile redeem through the API",async()=>{
  const target=randomUUID(),issued=await issue(target),app=await appFor({id:target,email:"verified@example.test"});
  const result=await app.inject({method:"POST",url:"/v1/me/pilot-invite/redeem",headers,payload:{request_id:randomUUID(),code:issued.code,display_name:"Synthetic customer"}});
  expect(result.statusCode).toBe(201);expect(result.headers["cache-control"]).toBe("no-store");expect(result.json().data.customer.type).toBe("pf");
  expect(result.body).not.toContain(issued.code!);expect(result.body).not.toContain("code_hash");
 });
 it("enforces MFA, role separation, strict input and disabled writes",async()=>{
  const admin=await appFor(operator),payload={request_id:randomUUID(),target_user_id:randomUUID(),reason};
  const path="/v1/admin/pilot-invites";
  const noMfa=await appFor({id:operator.id,email:operator.email});expect((await noMfa.inject({method:"POST",url:path,headers,payload})).statusCode).toBe(403);
  const existing=randomUUID();await customers.createOrGet({ownerUserId:existing,type:"pf",displayName:"Customer"});
  const client=await appFor({id:existing,email:"verified@example.test"});const denied=await client.inject({method:"POST",url:path,headers,payload});expect(denied.statusCode).toBe(403);expect(denied.json().error.code).toBe("OPERATOR_ACCOUNT_SEPARATION_REQUIRED");
  const invalid=await admin.inject({method:"POST",url:path,headers,payload:{...payload,slot:1}});expect(invalid.statusCode).toBe(400);
  const disabled=await (await appFor(operator,false)).inject({method:"POST",url:path,headers,payload});expect(disabled.statusCode).toBe(503);expect(disabled.json().error.code).toBe("PILOT_INVITES_DISABLED");
  expect((await admin.inject({method:"POST",url:path,payload})).statusCode).toBe(401);
 });
 it("keeps audit immutable, hashes private and browser roles unprivileged",async()=>{
  const issued=await issue();await expect(db.query("update peragus_pilot_invites set reason='Changed immutable reason' where id=$1",[issued.data.id])).rejects.toThrow("immutable");
  await expect(db.query("delete from peragus_pilot_invites where id=$1",[issued.data.id])).rejects.toThrow("cannot be deleted");
  const value=await service(false).read(operator,issued.data.id);expect(JSON.stringify(value)).not.toContain("code_hash");
  for(const role of ["anon","authenticated"])expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,'peragus_pilot_invites','select') or has_table_privilege($1,'peragus_pilot_invite_slots','update') as allowed",[role])).rows[0]!.allowed).toBe(false);
 });
 it("rolls back profile creation and admission when persistence fails",async()=>{
  const target=randomUUID(),issued=await issue(target),user={id:target,email:"verified@example.test"};
  await expect(service().redeem(user,randomUUID(),issued.code!,"x".repeat(200))).rejects.toThrow();
  expect(await customers.findByOwner(target)).toBeNull();expect((await service().read(operator,issued.data.id)).state).toBe("issued");
  expect((await db.query("select count(*)::int as n from peragus_pilot_invite_slots where admitted_user_id is not null")).rows[0]).toEqual({n:0});
  expect((await service().redeem(user,randomUUID(),issued.code!,"Synthetic customer")).replayed).toBe(false);
 });
 it("rate limits repeated invalid redemption attempts across requests",async()=>{
  const user={id:randomUUID(),email:"verified@example.test"},app=await appFor(user);
  for(let n=0;n<10;n++)expect((await app.inject({method:"POST",url:"/v1/me/pilot-invite/redeem",headers,payload:{request_id:randomUUID(),code:"pginv_"+"c".repeat(43),display_name:"Synthetic customer"}})).statusCode).toBe(409);
  const limited=await app.inject({method:"POST",url:"/v1/me/pilot-invite/redeem",headers,payload:{request_id:randomUUID(),code:"pginv_"+"c".repeat(43),display_name:"Synthetic customer"}});
  expect(limited.statusCode).toBe(429);expect(limited.headers["retry-after"]).toBe("900");
  expect(limited.json().error.code).toBe("PILOT_INVITE_RATE_LIMITED");
 });

});
