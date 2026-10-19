import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { CustomerScreeningService } from "../src/onboarding/customer-screening-service.js";
import { PostgresCustomerScreeningRepository } from "../src/repositories/postgres-customer-screening.js";
import { PostgresOnboardingSubmissionRepository } from "../src/repositories/postgres-onboarding-submission.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { OzavClient, type OzavWriteRequest } from "../src/providers/ozav-client.js";
const db = new PGlite(); let failSave = false;
const pool = { query: async (sql: string, params?: unknown[]) => {
  if (failSave && sql.includes("set screening_id=")) { failSave=false; throw new Error("save unavailable"); }
  const r=await db.query(sql,params);return {...r,rowCount:r.rows.length};
} } as unknown as Pool;
const customers=new PostgresCustomerRepository(pool), submissions=new PostgresOnboardingSubmissionRepository(pool), repo=new PostgresCustomerScreeningRepository(pool);
const apps: Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
  await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");
  const dir=new URL("../migrations/",import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(file,dir),"utf8"));
},30000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});
async function setup(type:"pf"|"pj"="pf") {
  const owner=randomUUID(),actor=(await customers.createOrGet({ownerUserId:owner,type,displayName:"Synthetic test"})).customer;
  const providerId=`ozav_cus_${actor.id.replaceAll("-","")}`,screeningId=`ozav_scr_${randomUUID().replaceAll("-","")}`, terms=randomUUID();
  await db.query("insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until) values($1,$2,$3,now())",[terms,actor.id,randomUUID()]);
  await db.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,verification_mode)
    values($1,$2,1,$3,$4,$5,'{}','linked',$6,'full')`,[randomUUID(),actor.id,terms,"a".repeat(64),randomUUID(),providerId]);
  const caps={environment:"test",entitlements:["customers","compliance"],scopes:["customers:read","screenings:read","screenings:write"]};
  let screenings:any[]=[], timeout=false, missList=false;
  const raw=()=>({id:screeningId,object:"screening",subject:{customer_id:providerId},lists:["sanctions","pep"],status:"completed",result:"clear",matches:[],suggested_decision:"clear",signals:[{private_data:"do not retain"}]});
  const transport=vi.fn(async(path:string)=>{
    if(path==="/v2/capabilities") return {statusCode:200,body:caps};
    if(path.startsWith("/v2/screenings?")) {expect(new URL(path,"https://example.test").searchParams.get("customer_id")).toBe(providerId);return {statusCode:200,body:{data:missList?[]:screenings,has_more:false,next_cursor:null}};}
    if(path.startsWith("/v2/screenings/"))return {statusCode:200,body:screenings.find(s=>path.endsWith(s.id))};
    return {statusCode:200,body:{id:providerId,object:"customer",type:"individual",external_ref:`peragus-onboarding-test:${actor.id}`,status:"approved",verification:{mode:"full",status:"approved"},requirements:{due:[],due_codes:[],missing_fields:[],documents_due:[]}}};
  });
  const writes:OzavWriteRequest[]=[];
  const writeTransport=vi.fn(async(request:OzavWriteRequest)=>{
    writes.push(request);expect(request.path).toBe("/v2/screenings");expect(request.body).toEqual({subject:{customer_id:providerId},lists:["sanctions","pep"]});
    expect(request.idempotencyKey).toBe((await repo.find(actor.id))?.idempotencyKey);
    if(screenings.length===0)screenings=[raw()];
    if(timeout){timeout=false;throw new Error("lost response");}
    return {statusCode:201,body:screenings[0]};
  });
  const provider=new OzavClient({apiKey:"ozav_sk_test_screening",attempts:1,transport,writeTransport});
  const service=new CustomerScreeningService(repo,submissions,provider);
  return {owner,actor,providerId,screeningId,caps,service,provider,transport,writeTransport,writes,raw,
    seed:(rows:any[])=>{screenings=rows;}, loseResponse:(hide=false)=>{timeout=true;missList=hide;}};
}
async function appFor(s:Awaited<ReturnType<typeof setup>>,enabled=true){
  const app=await buildApp({customerAccess:{customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return{id:s.owner,email:"private@example.test"};}},...(enabled?{customerScreeningService:s.service}:{})});apps.push(app);return app;
}
const path="/v1/me/onboarding/screening",headers={authorization:"Bearer valid"};
describe("test-only screening evidence",()=>{
  it("reserves an idempotency key before creation, replays and never approves a local customer",async()=>{
    const s=await setup(),app=await appFor(s);
    expect((await s.service.read(s.actor.id))).toBeNull();
    const first=await app.inject({method:"POST",url:path,headers,payload:{}});
    expect(first.statusCode).toBe(201);expect(first.json().data).toMatchObject({screening_id:s.screeningId,result:"clear",matches_count:0,operations_enabled:false});
    expect(first.headers["cache-control"]).toBe("no-store");expect(first.body).not.toContain("do not retain");expect(first.body).not.toContain("idempotency_key");
    expect((await app.inject({method:"POST",url:path,headers,payload:{}})).json().meta.idempotent_replay).toBe(true);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
    expect((await app.inject({method:"POST",url:"/v1/settlements",headers,payload:{}})).statusCode).toBe(403);
  });
  it("imports the single existing screening only after a fresh owned GET, without creating another",async()=>{
    const s=await setup();s.seed([s.raw()]);const result=await s.service.start(s.actor.id);
    expect(result.replayed).toBe(true);expect(result.data?.screening_id).toBe(s.screeningId);expect(s.writeTransport).not.toHaveBeenCalled();
    expect(s.transport.mock.calls.some(([p])=>p===`/v2/screenings/${s.screeningId}`)).toBe(true);
  });
  it("recovers provider success followed by a network or local database failure without another creation",async()=>{
    const network=await setup();network.loseResponse();await expect(network.service.start(network.actor.id)).rejects.toThrow();
    expect((await network.service.start(network.actor.id)).data?.screening_id).toBe(network.screeningId);expect(network.writeTransport).toHaveBeenCalledTimes(1);
    const database=await setup();failSave=true;await expect(database.service.start(database.actor.id)).rejects.toThrow("save unavailable");
    expect((await database.service.start(database.actor.id)).replayed).toBe(true);expect(database.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("uses exactly the reserved body and key on a retry when list lookup has not caught up",async()=>{
    const s=await setup();s.loseResponse(true);await expect(s.service.start(s.actor.id)).rejects.toThrow();await s.service.start(s.actor.id);
    expect(s.writes).toHaveLength(2);expect(s.writes[1]).toEqual(s.writes[0]);
  });
  it("refuses ambiguous history and screenings for other customers or different requested lists",async()=>{
    const ambiguous=await setup();ambiguous.seed([ambiguous.raw(),{...ambiguous.raw(),id:"ozav_scr_other"}]);
    await expect(ambiguous.service.start(ambiguous.actor.id)).rejects.toThrow("SCREENING_RECONCILIATION_REQUIRED");expect(ambiguous.writeTransport).not.toHaveBeenCalled();
    const foreign=await setup();foreign.seed([{...foreign.raw(),subject:{customer_id:"ozav_cus_foreign"}}]);await expect(foreign.service.start(foreign.actor.id)).rejects.toThrow();
    const lists=await setup();lists.seed([{...lists.raw(),lists:["sanctions"]}]);await expect(lists.service.start(lists.actor.id)).rejects.toThrow();
  });
  it("refreshes review and match evidence without converting it to clear or persisting personal match data",async()=>{
    const s=await setup();await s.service.start(s.actor.id);
    s.seed([{...s.raw(),result:"review",matches:[],suggested_decision:"review"}]);
    expect(await s.service.refresh(s.actor.id)).toMatchObject({result:"review",matches_count:0,suggested_decision:"review",operations_enabled:false});
    s.seed([{...s.raw(),result:"match_found",matches:[{matched_name:"private name",list_entry_ref:"private ref"}],suggested_decision:"decline"}]);
    expect(await s.service.refresh(s.actor.id)).toMatchObject({result:"match_found",matches_count:1,suggested_decision:"decline"});
    expect(JSON.stringify(await repo.find(s.actor.id))).not.toContain("private");expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
  });
  it("rejects clear with matches, absent evidence, foreign IDs and changed bindings",async()=>{
    const s=await setup();await s.service.start(s.actor.id);
    for(const value of [{...s.raw(),matches:[{}]},{...s.raw(),matches:undefined},{...s.raw(),id:"ozav_scr_other"}]){
      s.seed([value]);await expect(s.service.refresh(s.actor.id)).rejects.toThrow();
    }
    await db.query("update peragus_customer_onboarding_submissions set provider_customer_id='ozav_cus_changed' where customer_id=$1",[s.actor.id]);
    await expect(s.service.start(s.actor.id)).rejects.toThrow("SCREENING_CONFLICT");
  });
  it("validates complete pagination before linking existing evidence",async()=>{
    const s=await setup();let pages=0;
    const client=new OzavClient({apiKey:"ozav_sk_test_pages",attempts:1,transport:async(path)=>{
      expect(path).toContain("/v2/screenings?");pages++;
      return {statusCode:200,body:pages===1?{data:[s.raw()],has_more:true,next_cursor:"next"}:{data:[],has_more:false,next_cursor:null}};
    }});
    expect(await client.listCustomerScreenings(s.providerId)).toHaveLength(1);expect(pages).toBe(2);
    const duplicate=new OzavClient({apiKey:"ozav_sk_test_pages",attempts:1,transport:async()=>({statusCode:200,body:{data:[s.raw()],has_more:true,next_cursor:"same"}})});
    await expect(duplicate.listCustomerScreenings(s.providerId)).rejects.toThrow();
  });
  it("requires scoped test capabilities and a submitted customer",async()=>{
    const scope=await setup();scope.caps.scopes=["customers:read","screenings:read"];await expect(scope.service.start(scope.actor.id)).rejects.toThrow("SCREENING_CAPABILITY_REQUIRED");
    const live=await setup();live.caps.environment="live";await expect(live.service.start(live.actor.id)).rejects.toThrow("Invalid OZAV response");
    const missing=await setup();await db.query("delete from peragus_customer_onboarding_submissions where customer_id=$1",[missing.actor.id]);await expect(missing.service.start(missing.actor.id)).rejects.toThrow("SCREENING_CUSTOMER_REQUIRED");
    expect(scope.writeTransport).not.toHaveBeenCalled();expect(live.writeTransport).not.toHaveBeenCalled();
  });
  it("isolates accounts and refuses anonymous, PJ, suspended, disabled, spoofed and malformed requests",async()=>{
    const s=await setup(),other=await setup(),pj=await setup("pj"),app=await appFor(s);await s.service.start(s.actor.id);
    expect((await app.inject({method:"POST",url:path,payload:{}})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:path,headers,payload:{customer_id:other.providerId}})).statusCode).toBe(400);
    const malformed=await app.inject({method:"POST",url:path,headers:{...headers,"content-type":"application/json"},payload:'{"private":"sensitive",'});expect(malformed.statusCode).toBe(400);expect(malformed.body).not.toContain("sensitive");
    expect((await (await appFor(other)).inject({method:"GET",url:`${path}?customer_id=${s.actor.id}`,headers})).json().data).toBeNull();
    expect((await (await appFor(pj)).inject({method:"POST",url:path,headers,payload:{}})).statusCode).toBe(403);
    expect((await (await appFor(s,false)).inject({method:"GET",url:path,headers})).statusCode).toBe(503);
    await db.query("update peragus_customers set suspended=true where id=$1",[s.actor.id]);expect((await app.inject({method:"GET",url:path,headers})).statusCode).toBe(403);
  });
  it("rejects stale observations, has RLS and denies browser grants and live data",async()=>{
    const s=await setup();await s.service.start(s.actor.id);const old=(await repo.find(s.actor.id))!;await s.service.refresh(s.actor.id);
    await expect(repo.save(old,old.observation!)).rejects.toThrow("SCREENING_CONFLICT");
    await expect(db.query("update peragus_customer_screenings set environment='live' where customer_id=$1",[s.actor.id])).rejects.toThrow();
    const r=await db.query("select relrowsecurity,has_table_privilege('anon','peragus_customer_screenings','SELECT') as anon_select,has_table_privilege('authenticated','peragus_customer_screenings','INSERT') as auth_insert from pg_class where relname='peragus_customer_screenings'");
    expect(r.rows[0]).toEqual({relrowsecurity:true,anon_select:false,auth_insert:false});
  });
});
