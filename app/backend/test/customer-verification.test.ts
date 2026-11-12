import { allAcceptedLegal } from "./helpers/legal-double.js";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationError } from "../src/auth/customer-access.js";
import { CustomerVerificationService } from "../src/onboarding/customer-verification-service.js";
import { verificationChecks } from "../src/onboarding/verification-types.js";
import { PostgresCustomerVerificationRepository } from "../src/repositories/postgres-customer-verification.js";
import { PostgresOnboardingSubmissionRepository } from "../src/repositories/postgres-onboarding-submission.js";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { PostgresCustomerWebhookProcessor } from "../src/repositories/postgres-customer-webhook.js";
import { OzavClient, type OzavWriteRequest } from "../src/providers/ozav-client.js";

const db = new PGlite(); let failSave = false;
const pool = { query: async (sql: string, params?: unknown[]) => {
  if (failSave && sql.includes("set verification_id=")) { failSave = false; throw new Error("observation unavailable"); }
  const r = await db.query(sql,params); return { ...r, rowCount: r.rows.length };
} } as unknown as Pool;
const customers = new PostgresCustomerRepository(pool), submissions = new PostgresOnboardingSubmissionRepository(pool,"test"), repo = new PostgresCustomerVerificationRepository(pool,"test");
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(file,dir),"utf8"));
  await db.exec("insert into peragus_database_environment(environment) values('test')");
}, 30000);
afterAll(async () => { await Promise.all(apps.map(app=>app.close())); await db.close(); });
async function setup(type: "pf" | "pj" = "pf") {
  const owner = randomUUID(), actor = (await customers.createOrGet({ ownerUserId: owner, type, displayName: "Local test" })).customer;
  const providerId = `ozav_cus_${actor.id.replaceAll("-","")}`, verificationId = `ozav_vrf_${randomUUID().replaceAll("-","")}`;
  const termsId = randomUUID();
  await db.query("insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,environment) values($1,$2,$3,now(),'test')",[termsId,actor.id,randomUUID()]);
  await db.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,verification_mode,environment)
    values($1,$2,1,$3,$4,$5,'{}','linked',$6,'full','test')`,[randomUUID(),actor.id,termsId,"a".repeat(64),randomUUID(),providerId]);
  const caps = { environment: "test",entitlements:["customers","compliance"],scopes:["customers:read","verifications:read","verifications:write"] };
  let session: any = null, mode="full", customerStatus="approved", timeout=false, noCreate=false, contradictory=false, otherCustomer=false, hostileUrl=false, postConflict=false;
  const rawSession = (outcome: string="not_started", status="pending") => ({ id: verificationId, object:"verification",customer_id:otherCustomer?"ozav_cus_other":providerId,status,
    checks: Object.fromEntries(verificationChecks.map(check=>[check,{outcome,private_data:"never retain"}])), session_url:hostileUrl?"https://evil.example/session":undefined });
  const transport = vi.fn(async (path: string) => {
    if(path==="/v2/capabilities") return {statusCode:200,body:caps};
    if(path.startsWith("/v2/verifications?")) {
      const url = new URL(path,"https://example.test"); expect(url.searchParams.get("customer_id")).toBe(providerId);
      return {statusCode:200,body:{data:session?[session]:[],has_more:false,next_cursor:null}};
    }
    if(path.startsWith("/v2/verifications/")) return {statusCode:200,body:session};
    return {statusCode:200,body:{ id:providerId,object:"customer",type:"individual",external_ref:`peragus-onboarding-test:${actor.id}`,status:customerStatus,
      verification:{mode,status:customerStatus},requirements:{due:[],due_codes:[],missing_fields:[],documents_due:[]} }};
  });
  const writeTransport = vi.fn(async (request:OzavWriteRequest) => {
    if(request.path==="/v2/verifications") {
      expect(request.body).toEqual({customer_id:providerId,capabilities:[...verificationChecks]});
      expect(request.idempotencyKey).toBeUndefined();
      if(!noCreate) session=rawSession();
      if(timeout){timeout=false;throw new Error("unknown network result");}
      if(postConflict) return {statusCode:409,body:{error:{code:"VERIFICATION_ALREADY_EXISTS"}}};
      return {statusCode:201,body:session};
    }
    expect(request.path).toBe(`/v2/verifications/${verificationId}/simulate`);
    if(!contradictory) { session=rawSession(request.body.outcome==="approved"?"pass":"fail","completed");customerStatus=String(request.body.outcome); }
    return {statusCode:200,body:session};
  });
  const provider = new OzavClient({mode: "test", apiKey:"ozav_sk_test_verification",attempts:1,transport,writeTransport});
  const service=new CustomerVerificationService(repo,submissions,provider);
  return {owner,actor,providerId,verificationId,caps,provider,service,transport,writeTransport,
    timeout: (created=true)=>{timeout=true;noCreate=!created;}, setMode:(value:string)=>{mode=value;},
    conflict:()=>{postConflict=true;}, setForeign:()=>{otherCustomer=true;}, setHostile:()=>{hostileUrl=true;}, setContradictory:()=>{contradictory=true;},
    seed:(value:any)=>{session=value;}, rawSession};
}
const path="/v1/me/onboarding/verification",headers={authorization:"Bearer valid"};
async function appFor(s:Awaited<ReturnType<typeof setup>>, enabled=true, simulation=false){
  const app=await buildApp({customerAccess:{ legal: allAcceptedLegal,customers,authenticate:async token=>{if(token!=="valid")throw new AuthenticationError("INVALID_TOKEN");return{id:s.owner,email:"private@example.test"};}},
    ...(enabled?{customerVerificationService:s.service,verificationSimulationEnabled:simulation}:{})});apps.push(app);return app;
}
describe("sandbox identity verification",()=>{
  it("starts once, replays the linked session and exposes sanitized checks without a hosted link or local approval",async()=>{
    const s=await setup(),app=await appFor(s);
    expect((await app.inject({method:"GET",url:path,headers})).json().data).toBeNull();
    const first=await app.inject({method:"POST",url:path,headers,payload:{}});
    expect(first.statusCode).toBe(201);expect(first.json().data).toMatchObject({verification_id:s.verificationId,status:"pending",session_url:null,operations_enabled:false,sandbox_only:true});
    expect(first.body).not.toContain("never retain");
    const replay=await app.inject({method:"POST",url:path,headers,payload:{}});
    expect(replay.statusCode).toBe(200);expect(s.writeTransport).toHaveBeenCalledTimes(1);
    expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
    expect((await app.inject({method:"POST",url:"/v1/settlements",headers,payload:{}})).statusCode).toBe(403);
  });
  it("recovers a timeout-created verification by customer lookup without repeating POST",async()=>{
    const s=await setup();s.timeout();
    await expect(s.service.start(s.actor.id)).rejects.toThrow("OZAV connection failed");
    expect((await repo.find(s.actor.id))?.createAttempted).toBe(true);
    expect((await s.service.start(s.actor.id)).data?.verification_id).toBe(s.verificationId);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("recovers the documented already-exists conflict by customer lookup",async()=>{
    const s=await setup();s.conflict();
    expect((await s.service.start(s.actor.id)).data?.verification_id).toBe(s.verificationId);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
    expect((await s.service.start(s.actor.id)).replayed).toBe(true);
  });
  it("keeps absent checks unknown rather than fabricating passed results",async()=>{
    const s=await setup();await s.service.start(s.actor.id);
    s.seed({...s.rawSession(),status:"completed",checks:{kyc_document:{outcome:"pass"}}});
    const result=await s.service.refresh(s.actor.id);
    expect(result?.observed_outcome).toBeNull();expect(result?.checks.liveness).toBeUndefined();
  });
  it("does not blindly repeat a create when its result cannot be found",async()=>{
    const s=await setup();s.timeout(false);
    await expect(s.service.start(s.actor.id)).rejects.toThrow();
    await expect(s.service.start(s.actor.id)).rejects.toThrow("VERIFICATION_RECOVERY_REQUIRED");
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("recovers after local persistence failure with one provider create",async()=>{
    const s=await setup();failSave=true;
    await expect(s.service.start(s.actor.id)).rejects.toThrow("observation unavailable");
    expect((await s.service.start(s.actor.id)).data?.verification_id).toBe(s.verificationId);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("simulates rejection/approval and refreshes the parent while local operations remain blocked",async()=>{
    const s=await setup(),app=await appFor(s,true,true);await s.service.start(s.actor.id);
    const rejected=await app.inject({method:"POST",url:`${path}/simulate`,headers,payload:{outcome:"rejected"}});
    expect(rejected.statusCode).toBe(200);expect(rejected.json().data.observed_outcome).toBe("rejected");
    expect((await submissions.find(s.actor.id))?.snapshot?.provider_status).toBe("rejected");
    const approved=await app.inject({method:"POST",url:`${path}/simulate`,headers,payload:{outcome:"approved"}});
    expect(approved.json().data.observed_outcome).toBe("approved");expect(approved.json().data.operations_enabled).toBe(false);
    const repeat=await app.inject({method:"POST",url:`${path}/simulate`,headers,payload:{outcome:"approved"}});
    expect(repeat.json().meta.idempotent_replay).toBe(true);expect(s.writeTransport).toHaveBeenCalledTimes(3);
    expect((await s.service.refresh(s.actor.id))?.checks.kyc_document).toBe("pass");
    expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
  });
  it("preserves simulated result on DB failure and retries by observation, not a second simulation",async()=>{
    const s=await setup();await s.service.start(s.actor.id);failSave=true;
    await expect(s.service.simulate(s.actor.id,"approved")).rejects.toThrow("observation unavailable");
    expect((await s.service.simulate(s.actor.id,"approved")).replayed).toBe(true);
    expect(s.writeTransport).toHaveBeenCalledTimes(2);
  });
  it("separates passed identity capture from AML not started and acknowledges a completed simulation without resubmitting",async()=>{
    const s=await setup();await s.service.start(s.actor.id);
    const observed=s.rawSession("pass","completed");observed.checks.aml_name_screening.outcome="not_started";s.seed(observed);
    const refreshed=await s.service.refresh(s.actor.id);
    expect(refreshed).toMatchObject({identity_outcome:"approved",observed_outcome:null,operations_enabled:false});
    const simulation=await s.service.simulate(s.actor.id,"approved");
    expect(simulation.replayed).toBe(true);expect(simulation.data?.identity_outcome).toBe("approved");
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
    expect((await customers.findByOwner(s.owner))?.verificationStatus).toBe("draft");
  });
  it("does not pretend an inconclusive or contradictory result is approved",async()=>{
    const s=await setup();await s.service.start(s.actor.id);s.setContradictory();
    await expect(s.service.simulate(s.actor.id,"approved")).rejects.toThrow("VERIFICATION_OUTCOME_MISMATCH");
    s.seed(s.rawSession("review","completed"));
    expect((await s.service.refresh(s.actor.id))?.observed_outcome).toBeNull();
  });
  it("blocks reliance, insufficient scopes and customers without a submitted binding",async()=>{
    const reliance=await setup();reliance.setMode("reliance");
    await expect(reliance.service.start(reliance.actor.id)).rejects.toThrow("VERIFICATION_FULL_MODE_REQUIRED");
    expect(reliance.writeTransport).not.toHaveBeenCalled();
    const scope=await setup();scope.caps.scopes=["customers:read","verifications:read"];
    await expect(scope.service.start(scope.actor.id)).rejects.toThrow("VERIFICATION_CAPABILITY_REQUIRED");
    const missing=await setup();await db.query("delete from peragus_customer_onboarding_submissions where customer_id=$1",[missing.actor.id]);
    await expect(missing.service.start(missing.actor.id)).rejects.toThrow("VERIFICATION_CUSTOMER_REQUIRED");
  });
  it("refuses ambiguous lookup, foreign customer results and hosted URLs in sandbox",async()=>{
    const ambiguous=await setup();const one=ambiguous.rawSession();
    const fake={getCustomerCapabilities:ambiguous.provider.getCustomerCapabilities.bind(ambiguous.provider),
      getSandboxCustomerSnapshot:ambiguous.provider.getSandboxCustomerSnapshot.bind(ambiguous.provider),
      listCustomerVerifications:async()=>[{id:"ozav_vrf_a"},{id:"ozav_vrf_b"}]} as any;
    const service=new CustomerVerificationService(repo,submissions,fake);
    await expect(service.start(ambiguous.actor.id)).rejects.toThrow("VERIFICATION_RECOVERY_REQUIRED");
    const foreign=await setup();foreign.setForeign();await expect(foreign.service.start(foreign.actor.id)).rejects.toThrow();
    const url=await setup();url.setHostile();await expect(url.service.start(url.actor.id)).rejects.toThrow();
    expect(one.customer_id).toBe(ambiguous.providerId);
  });
  it("isolates owners and blocks simulation by default, client-chosen IDs, PJ, suspended and anonymous calls",async()=>{
    const s=await setup(),other=await setup(),pj=await setup("pj"),app=await appFor(s);
    await s.service.start(s.actor.id);
    expect((await app.inject({method:"POST",url:`${path}/simulate`,headers,payload:{outcome:"approved"}})).statusCode).toBe(503);
    expect((await app.inject({method:"POST",url:path,headers,payload:{customer_id:other.providerId}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:path,payload:{}})).statusCode).toBe(401);
    expect((await (await appFor(pj)).inject({method:"POST",url:path,headers,payload:{}})).statusCode).toBe(403);
    expect((await (await appFor(s,false)).inject({method:"GET",url:path,headers})).statusCode).toBe(503);
    expect((await (await appFor(other)).inject({method:"GET",url:`${path}?customer_id=${s.actor.id}`,headers})).json().data).toBeNull();
    await db.query("update peragus_customers set suspended=true where id=$1",[s.actor.id]);
    expect((await app.inject({method:"GET",url:path,headers})).statusCode).toBe(403);
  });
  it("rejects stale writes and retains browser/test environment protections",async()=>{
    const s=await setup();await s.service.start(s.actor.id);const row=(await repo.find(s.actor.id))!;
    await s.service.refresh(s.actor.id);await expect(repo.save(row,row.observation!)).rejects.toThrow("VERIFICATION_CONFLICT");
    await expect(db.query("update peragus_customer_verifications set environment='live' where customer_id=$1",[s.actor.id])).rejects.toThrow();
    const r=await db.query(`select relrowsecurity,has_table_privilege('anon','peragus_customer_verifications','SELECT') as anon_select,
      has_table_privilege('authenticated','peragus_customer_verifications','INSERT') as auth_insert from pg_class where relname='peragus_customer_verifications'`);
    expect(r.rows[0]).toEqual({relrowsecurity:true,anon_select:false,auth_insert:false});
  });
});

// Live money mode on a PGlite database recorded as 'live'. No real OZAV: transports are fakes.
describe("live hosted identity verification", () => {
  const liveDb = new PGlite();
  const liveQuery = async (sql: string, params?: unknown[]) => { const r = await liveDb.query(sql, params); return { ...r, rowCount: r.rows.length }; };
  const livePool = { query: liveQuery, connect: async () => ({ query: liveQuery, release: () => {} }) } as unknown as Pool;
  const liveCustomers = new PostgresCustomerRepository(livePool), liveSubmissions = new PostgresOnboardingSubmissionRepository(livePool, "live"),
    liveRepo = new PostgresCustomerVerificationRepository(livePool, "live");
  const hosted = "https://verify.ozav.io/session/abc123";
  beforeAll(async () => {
    await liveDb.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon,authenticated;");
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await liveDb.exec(await readFile(new URL(file, dir), "utf8"));
    await liveDb.exec("insert into peragus_database_environment(environment) values('live')");
  }, 30000);
  afterAll(async () => { await liveDb.close(); });
  async function live() {
    const owner = randomUUID(), actor = (await liveCustomers.createOrGet({ ownerUserId: owner, type: "pf", displayName: "Live person" })).customer;
    const providerId = `ozav_cus_${actor.id.replaceAll("-", "")}`, verificationId = `ozav_vrf_${randomUUID().replaceAll("-", "")}`, termsId = randomUUID();
    await liveDb.query("insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until,environment) values($1,$2,$3,now(),'live')", [termsId, actor.id, randomUUID()]);
    await liveDb.query(`insert into peragus_customer_onboarding_submissions(id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,state,provider_customer_id,verification_mode,environment)
      values($1,$2,1,$3,$4,$5,'{}','linked',$6,'full','live')`, [randomUUID(), actor.id, termsId, "b".repeat(64), randomUUID(), providerId]);
    const caps = { environment: "live", entitlements: ["customers", "compliance"], scopes: ["customers:read", "verifications:read", "verifications:write"] };
    let sessionUrl: string | undefined = hosted, status = "pending", outcome = "not_started", postStatus = 201, getUrl: string | undefined = hosted;
    const raw = (url: string | undefined) => ({ id: verificationId, object: "verification", customer_id: providerId, status,
      checks: Object.fromEntries(verificationChecks.map(check => [check, { outcome }])), ...(url === undefined ? {} : { session_url: url }) });
    const transport = vi.fn(async (p: string) => {
      if (p === "/v2/capabilities") return { statusCode: 200, body: caps };
      if (p.startsWith("/v2/verifications?")) return { statusCode: 200, body: { data: [], has_more: false, next_cursor: null } };
      if (p.startsWith("/v2/verifications/")) return { statusCode: 200, body: raw(getUrl) };
      return { statusCode: 200, body: { id: providerId, object: "customer", type: "individual", external_ref: `peragus-onboarding:${actor.id}`, status: "pending",
        verification: { mode: "full", status }, requirements: { due: [], due_codes: [], missing_fields: [], documents_due: [] } } };
    });
    const writeTransport = vi.fn(async (request: OzavWriteRequest) => {
      expect(request.path).toBe("/v2/verifications");
      if (postStatus === 503) { postStatus = 201; return { statusCode: 503, body: { error: { code: "VERIFICATION_SESSION_UNAVAILABLE" } } }; }
      return { statusCode: 201, body: raw(sessionUrl) };
    });
    const provider = new OzavClient({ mode: "live", apiKey: "ozav_sk_live_verification", attempts: 1, transport, writeTransport });
    const service = new CustomerVerificationService(liveRepo, liveSubmissions, provider, "live");
    return { owner, actor, providerId, verificationId, service, transport, writeTransport, provider,
      setSession: (value: string | undefined) => { sessionUrl = value; getUrl = value; }, setGetUrl: (value: string | undefined) => { getUrl = value; },
      complete: () => { status = "completed"; outcome = "pass"; }, unavailableOnce: () => { postStatus = 503; } };
  }
  async function liveApp(s: Awaited<ReturnType<typeof live>>) {
    const app = await buildApp({ moneyMode: "live", customerAccess: { legal: allAcceptedLegal, customers: liveCustomers, authenticate: async token => {
      if (token !== "valid") throw new AuthenticationError("INVALID_TOKEN"); return { id: s.owner, email: "person@real-mail.test" }; } },
      customerVerificationService: s.service }); apps.push(app); return app;
  }
  it("live start returns the hosted session_url and replays it without a second create", async () => {
    const s = await live(), app = await liveApp(s);
    const first = await app.inject({ method: "POST", url: path, headers, payload: {} });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ verification_id: s.verificationId, status: "pending", session_url: hosted, environment: "live", sandbox_only: false });
    const replay = await app.inject({ method: "POST", url: path, headers, payload: {} });
    expect(replay.statusCode).toBe(200); expect(replay.json().data.session_url).toBe(hosted);
    expect((await app.inject({ method: "GET", url: path, headers })).json().data.session_url).toBe(hosted);
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("live without session_url fails with VERIFICATION_SESSION_UNAVAILABLE (fail closed) and never re-creates", async () => {
    const s = await live(), app = await liveApp(s); s.setSession(undefined);
    const first = await app.inject({ method: "POST", url: path, headers, payload: {} });
    expect(first.statusCode).toBe(503); expect(first.json().error.code).toBe("VERIFICATION_SESSION_UNAVAILABLE");
    await expect(s.service.start(s.actor.id)).rejects.toThrow("VERIFICATION_SESSION_UNAVAILABLE");
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
    expect((await liveRepo.find(s.actor.id))?.verificationId).toBe(s.verificationId);
  });
  it("retries a documented 503 VERIFICATION_SESSION_UNAVAILABLE create, since OZAV persisted nothing", async () => {
    const s = await live(); s.unavailableOnce();
    await expect(s.service.start(s.actor.id)).rejects.toThrow("VERIFICATION_SESSION_UNAVAILABLE");
    expect((await s.service.start(s.actor.id)).data?.session_url).toBe(hosted);
    expect(s.writeTransport).toHaveBeenCalledTimes(2);
  });
  it.each(["http://verify.ozav.io/s", "https://verify.ozav.io.evil.example/s", "https://evilozav.io/s", "https://user:pw@verify.ozav.io/s",
    "https://verify.ozav.io:8443/s", "javascript:alert(1)", "https://evil.example/s"])("refuses a hosted session URL outside OZAV: %s", async url => {
    const s = await live(); s.setSession(url);
    await expect(s.service.start(s.actor.id)).rejects.toThrow();
    expect(JSON.stringify((await liveRepo.find(s.actor.id))?.observation ?? null)).not.toContain(url);
  });
  it("keeps the session link across a GET that omits it and hides it once the session is completed", async () => {
    const s = await live(); await s.service.start(s.actor.id); s.setGetUrl(undefined);
    expect((await s.service.refresh(s.actor.id))?.session_url).toBe(hosted);
    s.complete();
    expect(await s.service.refresh(s.actor.id)).toMatchObject({ status: "completed", identity_outcome: "approved", session_url: null });
  });
  it("never simulates in live: no route and the service refuses before any provider call", async () => {
    const s = await live(), app = await liveApp(s); await s.service.start(s.actor.id);
    expect((await app.inject({ method: "POST", url: `${path}/simulate`, headers, payload: { outcome: "approved" } })).statusCode).toBe(404);
    await expect(s.service.simulate(s.actor.id, "approved")).rejects.toThrow("VERIFICATION_SIMULATION_UNAVAILABLE");
    await expect(s.provider.simulateCustomerVerification(s.providerId, s.verificationId, "approved")).rejects.toThrow();
    expect(s.writeTransport).toHaveBeenCalledTimes(1);
  });
  it("verification.updated triggers a GET refresh of the verification (the GET is the truth)", async () => {
    const s = await live(); await s.service.start(s.actor.id); s.complete();
    const processor = new PostgresCustomerWebhookProcessor(livePool, s.provider, "live");
    const event = { id: `ozav_evt_${randomUUID().replaceAll("-", "")}`, object: "event" as const, type: "verification.updated", livemode: true,
      created_at: new Date().toISOString(), data: { verification: { id: s.verificationId, customer_id: s.providerId, status: "rejected" } } };
    expect(await processor.process(event, "c".repeat(64))).toBe("processed");
    expect(s.transport.mock.calls.map(([p]) => p)).toContain(`/v2/verifications/${s.verificationId}`);
    expect(await s.service.read(s.actor.id)).toMatchObject({ status: "completed", identity_outcome: "approved" });
    expect((await liveSubmissions.find(s.actor.id))?.snapshot?.verification_status).toBe("completed");
    expect(await processor.process(event, "c".repeat(64))).toBe("duplicate");
  });
});
