import {randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {envSchema} from "../src/config/env.js";
import {PostgresCustomerPurchaseIntentRepository,transitionOperationInTransaction} from "../src/repositories/postgres-customer-purchase-intents.js";
import {PostgresCustomerPixRepository} from "../src/repositories/postgres-customer-sandbox-pix.js";
import {CustomerPurchaseIntentService} from "../src/purchases/customer-purchase-intents.js";
import {CustomerSandboxPixService} from "../src/purchases/customer-sandbox-pix.js";
import type {OperationStatus} from "../src/purchases/operation-status.js";
import {RuntimeControlService} from "../src/operations/runtime-controls.js";
import {DRAIN_MAX,drainOperatorNotifications,operatorNotificationConfig,SEND_TIMEOUT_MS,OperatorNotificationSendError,recordWebhookSignatureInvalid,
 renderOperatorNotification,ResendOperatorNotificationSender,type OperatorNotificationSender} from "../src/operations/operator-notifications.js";
import {OPERATOR_JOB_EXPIRE_SECONDS,OPERATOR_NOTIFICATIONS_QUEUE,registerOperatorNotificationJobs,STUCK_OPERATIONS_QUEUE,StuckOperationScanner} from "../src/jobs/stuck-operations.js";
import {enableRuntimeControls} from "./helpers/runtime-controls.js";
import {migrateAll,pglitePool,purchaseReadyCustomer} from "./helpers/operation-fixture.js";

vi.setConfig({testTimeout:60000});
const db=new PGlite(),pool=pglitePool(db);
const wide={maxOpenGlobal:1000,limits:{minCents:1n,maxCents:1000000n}};
const repository=new PostgresCustomerPurchaseIntentRepository(pool,"test",wide);
const purchases=new CustomerPurchaseIntentService(repository);
const scanner=new StuckOperationScanner(pool,"test");
const config={mode:"test" as const,from:"alertas@peragus.com.br",recipients:{operator:"operator-inbox@example.test",trusted:"trusted-inbox@example.test"}};
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];

beforeAll(async()=>{await migrateAll(db);await db.exec("insert into peragus_database_environment(environment) values('test')");await enableRuntimeControls(db);},60000);
afterAll(async()=>{await Promise.all(apps.map(a=>a.close()));await db.close();});

const PATH:OperationStatus[]=["awaiting_pix","pix_confirmed","converted","awaiting_approval","approved","sending","sent"];
/** A new accepted operation moved along `to` (each a valid transition). */
async function operation(to:OperationStatus[]=[]){
 const s=await purchaseReadyCustomer(db,pool);
 const accepted=await purchases.record(s.customer.id,s.requestId,s.quoteId);
 for(const status of to){
  await repository.transitionOperation(accepted.data.id,status,"system:test",`SYNTHETIC_${status.toUpperCase()}: test`);
  // "Cliente pagou — aprovar" (056) is covered by its own test; send it here so the
  // tests below see only the notifications of the later transitions.
  if(status==="awaiting_approval")await drainOperatorNotifications(pool,fakeSender().sender,config,1000);
 }
 return{...s,purchaseId:accepted.data.id};
}
const until=(status:OperationStatus)=>PATH.slice(0,PATH.indexOf(status)+1);
type Note={kind:string;recipient:string;severity:string;status:string;dedupe_key:string;idempotency_key:string;payload:any;attempts:number;id:string};
const notes=async(where:string,params:unknown[]=[])=>(await db.query<Note>(`select id,kind,recipient,severity,status,dedupe_key,idempotency_key,payload,attempts
 from peragus_operator_notifications where ${where} order by kind,dedupe_key,recipient`,params)).rows;
const forPurchase=(id:string)=>notes("purchase_id=$1 and kind<>'awaiting_approval'",[id]);
const at=(minutes:number)=>new Date(Date.now()+minutes*60_000);
function fakeSender(behaviour:()=>Promise<string>|string=()=>`email-${randomUUID()}`){
 const calls:{key:string;message:{from:string;to:string[];subject:string;text:string}}[]=[];
 const sender:OperatorNotificationSender={send:async(key,message)=>{calls.push({key,message});return behaviour();}};
 return{sender,calls};
}
function pixFixture(){
 const provider={getCustomerCapabilities:async()=>({environment:"test",entitlements:["customers","liquidity","custody"],scopes:["customers:read","wallets:read","transfers:read","transfers:write"]}),
  getSandboxCustomerSnapshot:async()=>({provider_status:"approved",verification_mode:"full",requirements_pending:false}),
  getCustomerManagedWallet:async()=>"ozav_wal_testmanaged",
  createCustomerPixTransfer:async(input:any)=>{const id=`ozav_tr_${randomUUID().replaceAll("-","")}`;return{id,transfer:{id,status:"awaiting_payment",customerId:input.customerId,quoteId:input.quoteId,
   source:{type:"fiat_payment",currency:"BRL",rail:"pix",paymentInstructions:{intentId:randomUUID(),brCode:"sandbox-code",qrCodeImage:null,expiresAt:new Date(Date.now()+60_000).toISOString()}},
   destination:{type:"wallet",walletId:"ozav_wal_testmanaged"},sourceLegStatus:"pending",destinationLegStatus:"pending",
   amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}}}};},
  getTransfer:async()=>{throw new Error("not used");}} as any;
 return new CustomerSandboxPixService(new PostgresCustomerPixRepository(pool,"test"),provider,"test",purchases);
}

describe("operator notifications",()=>{
 it("a paid operation reaching awaiting_approval notifies the operator to approve (warn)",async()=>{
  const s=await purchaseReadyCustomer(db,pool),accepted=await purchases.record(s.customer.id,s.requestId,s.quoteId);
  for(const status of until("converted"))await repository.transitionOperation(accepted.data.id,status,"system:test",`SYNTHETIC_${status.toUpperCase()}: test`);
  expect(await notes("purchase_id=$1 and kind='awaiting_approval'",[accepted.data.id])).toEqual([]);
  await repository.transitionOperation(accepted.data.id,"awaiting_approval","system:reconciliation","withdrawal_request_recorded");
  const rows=await notes("purchase_id=$1 and kind='awaiting_approval'",[accepted.data.id]);
  expect(rows.map(r=>[r.recipient,r.severity])).toEqual([["operator","warn"],["trusted","warn"]]);
  const email=renderOperatorNotification(rows[0]!.payload,"test");
  expect(email.subject).toContain("Cliente pagou");
 });
 it("approval enqueues one notification per recipient, in the transition's transaction",async()=>{
  const op=await operation(until("approved"));
  const rows=await forPurchase(op.purchaseId);
  // Only money-relevant transitions notify: here, the approval.
  expect(rows.map(r=>[r.kind,r.recipient,r.severity,r.status])).toEqual([["approval","operator","info","pending"],["approval","trusted","info","pending"]]);
  expect(new Set(rows.map(r=>r.dedupe_key)).size).toBe(1);
  for(const r of rows)expect(r.idempotency_key).toBe(`peragus-operator-notification-test/${r.id}`);
  expect(rows[0]!.payload).toMatchObject({kind:"approval",environment:"test",purchase_id:op.purchaseId,status:"approved",
   source_amount_brl:"1000.00",locked_usdt_amount:"200.000000",from_status:"awaiting_approval",to_status:"approved",reason_code:"SYNTHETIC_APPROVED"});
  // Same transaction: a rolled-back transition leaves no notification behind.
  const client=await pool.connect();
  try{
   await client.query("begin");
   await transitionOperationInTransaction(client,"test",op.purchaseId,"sending","system:test","SEND_CLAIMED: test",{from:"approved"});
   expect((await client.query("select count(*)::int n from peragus_operator_notifications where purchase_id=$1 and kind='execution'",[op.purchaseId])).rows[0]).toEqual({n:2});
   await client.query("rollback");
  }finally{client.release();}
  expect((await forPurchase(op.purchaseId)).map(r=>r.kind)).toEqual(["approval","approval"]);
  // The committed send claim notifies execution; replaying the same status is not a new event.
  await repository.transitionOperation(op.purchaseId,"sending","system:test","SEND_CLAIMED: test");
  await repository.transitionOperation(op.purchaseId,"sending","system:test","SEND_CLAIMED: test");
  expect((await forPurchase(op.purchaseId)).map(r=>r.kind)).toEqual(["approval","approval","execution","execution"]);
 });

 it("retrying the worker does not send twice",async()=>{
  await drainOperatorNotifications(pool,fakeSender().sender,config,1000);
  const op=await operation(until("approved"));
  const ok=fakeSender();
  expect(await drainOperatorNotifications(pool,ok.sender,config)).toMatchObject({accepted:2,failed:0,uncertain:0});
  const rows=await forPurchase(op.purchaseId);
  expect(rows.map(r=>[r.status,r.attempts])).toEqual([["accepted",1],["accepted",1]]);
  expect(ok.calls.map(c=>c.key).sort()).toEqual(rows.map(r=>r.idempotency_key).sort());
  expect(ok.calls.map(c=>c.message.to[0]).sort()).toEqual([config.recipients.operator,config.recipients.trusted]);
  expect(await drainOperatorNotifications(pool,ok.sender,config)).toMatchObject({accepted:0});
  expect(ok.calls).toHaveLength(2);
  // Ambiguous provider outcome: uncertain, never retried automatically.
  const second=await operation(until("approved"));
  const ambiguous=fakeSender(()=>{throw new OperatorNotificationSendError(false);});
  expect(await drainOperatorNotifications(pool,ambiguous.sender,config)).toMatchObject({uncertain:2});
  const later=fakeSender();
  await drainOperatorNotifications(pool,later.sender,config);
  expect(later.calls).toHaveLength(0);
  expect((await forPurchase(second.purchaseId)).map(r=>[r.status,r.attempts])).toEqual([["uncertain",1],["uncertain",1]]);
  // Definitive rejection: failed, not retried.
  const third=await operation(until("approved"));
  await drainOperatorNotifications(pool,fakeSender(()=>{throw new OperatorNotificationSendError(true);}).sender,config);
  expect((await forPurchase(third.purchaseId)).map(r=>r.status)).toEqual(["failed","failed"]);
  // A worker that died after recording the attempt (row left 'sending') is never re-sent.
  const fourth=await operation(until("approved"));
  await db.query("update peragus_operator_notifications set status='sending',attempts=1,first_attempt_at=now(),updated_at=now()-interval '10 minutes' where purchase_id=$1 and status='pending'",[fourth.purchaseId]);
  const after=fakeSender();
  await drainOperatorNotifications(pool,after.sender,config);
  expect(after.calls).toHaveLength(0);
  expect((await forPurchase(fourth.purchaseId)).map(r=>r.status)).toEqual(["uncertain","uncertain"]);
 });

 it("sending for 31 minutes raises stuck_operation once",async()=>{
  const op=await operation(until("sending"));
  const stuck=()=>notes("purchase_id=$1 and kind='stuck_operation'",[op.purchaseId]);
  await scanner.scan(at(29));
  expect(await stuck()).toEqual([]);
  await scanner.scan(at(31));
  await scanner.scan(at(36));
  await scanner.scan(at(41));
  const rows=await stuck();
  expect(rows.map(r=>[r.recipient,r.severity])).toEqual([["operator","high"],["trusted","high"]]);
  expect(rows[0]!.payload).toMatchObject({kind:"stuck_operation",status:"sending",threshold:"sending_30m"});
  // sent for more than 30 minutes without on-chain verification.
  const sent=await operation(until("sent"));
  await scanner.scan(at(31));await scanner.scan(at(35));
  expect((await notes("purchase_id=$1 and kind='stuck_operation'",[sent.purchaseId])).map(r=>r.payload.threshold)).toEqual(["sent_30m_unverified","sent_30m_unverified"]);
 });

 it("stage thresholds: pix_confirmed/approved warn 2 h and high 8 h, awaiting_approval warn 1 h and high 4 h, each once",async()=>{
  const paid=await operation(["awaiting_pix","pix_confirmed"]),waiting=await operation(until("awaiting_approval")),approved=await operation(until("approved"));
  const stage=async(id:string)=>(await notes("purchase_id=$1 and kind='stuck_operation' and recipient='operator'",[id])).map(r=>`${r.payload.threshold}:${r.severity}`).sort();
  await scanner.scan(at(59));
  expect([await stage(paid.purchaseId),await stage(waiting.purchaseId),await stage(approved.purchaseId)]).toEqual([[],[],[]]);
  await scanner.scan(at(61));await scanner.scan(at(66));
  expect(await stage(waiting.purchaseId)).toEqual(["awaiting_approval_1h:warn"]);
  expect(await stage(paid.purchaseId)).toEqual([]);
  await scanner.scan(at(2*60+1));
  expect(await stage(paid.purchaseId)).toEqual(["pix_confirmed_2h:warn"]);
  expect(await stage(approved.purchaseId)).toEqual(["approved_2h:warn"]);
  await scanner.scan(at(8*60+1));await scanner.scan(at(8*60+6));
  expect(await stage(paid.purchaseId)).toEqual(["pix_confirmed_2h:warn","pix_confirmed_8h:high"]);
  expect(await stage(waiting.purchaseId)).toEqual(["awaiting_approval_1h:warn","awaiting_approval_4h:high"]);
  expect(await stage(approved.purchaseId)).toEqual(["approved_2h:warn","approved_8h:high"]);
 });

 it("needs_review alerts at 4 h and 12 h, refund_pending at 12 h and 20 h, awaiting_pix past its deadline, each once",async()=>{
  const review=await operation(["needs_review"]);
  const refund=await operation(["awaiting_pix","pix_confirmed","refund_pending"]);
  const thresholds=async(id:string,kind:string)=>(await notes("purchase_id=$1 and kind=$2 and payload ? 'threshold'",[id,kind])).map(r=>`${r.payload.threshold}:${r.severity}`);
  await scanner.scan(at(3*60+59));
  expect(await thresholds(review.purchaseId,"needs_review")).toEqual([]);
  await scanner.scan(at(4*60+1));await scanner.scan(at(4*60+6));
  expect(await thresholds(review.purchaseId,"needs_review")).toEqual(["4h:warn","4h:warn"]);
  expect(await thresholds(refund.purchaseId,"refund_pending")).toEqual([]);
  await scanner.scan(at(12*60+1));await scanner.scan(at(12*60+6));
  expect(await thresholds(review.purchaseId,"needs_review")).toEqual(["12h:high","12h:high","4h:warn","4h:warn"]);
  expect(await thresholds(refund.purchaseId,"refund_pending")).toEqual(["12h:warn","12h:warn"]);
  await scanner.scan(at(20*60+1));await scanner.scan(at(20*60+6));
  expect(await thresholds(refund.purchaseId,"refund_pending")).toEqual(["12h:warn","12h:warn","20h:high","20h:high"]);
  // The transitions themselves notified at once (needs_review high, refund_pending warn).
  expect((await notes("purchase_id=$1 and not payload ? 'threshold'",[review.purchaseId])).map(r=>`${r.kind}:${r.severity}`)).toEqual(["needs_review:high","needs_review:high"]);
  // awaiting_pix past min(Pix expiry, lock deadline): the fixture's Pix expires in 60 s.
  const s=await purchaseReadyCustomer(db,pool);
  const accepted=await purchases.record(s.customer.id,s.requestId,s.quoteId);
  await pixFixture().create(s.customer.id,randomUUID(),accepted.data.id);
  expect((await db.query("select status from peragus_customer_purchase_intents where id=$1",[accepted.data.id])).rows[0]).toEqual({status:"awaiting_pix"});
  await scanner.scan(at(0));
  expect(await notes("purchase_id=$1 and kind='stuck_operation'",[accepted.data.id])).toEqual([]);
  await scanner.scan(at(2));await scanner.scan(at(7));
  expect((await notes("purchase_id=$1 and kind='stuck_operation'",[accepted.data.id])).map(r=>r.payload.threshold)).toEqual(["awaiting_pix_expired","awaiting_pix_expired"]);
  // An existing high-severity alert (reconciliation review) is e-mailed once.
  const pix=(await db.query<{id:string}>("select id from peragus_customer_sandbox_pix where purchase_intent_id=$1",[accepted.data.id])).rows[0]!.id;
  await db.query("insert into peragus_customer_reconciliation(customer_id,purchase_intent_id,pix_id,state,manual_review_required,environment) values($1,$2,$3,'needs_review',true,'test')",[s.customer.id,accepted.data.id,pix]);
  await scanner.scan();await scanner.scan();
  expect((await notes("purchase_id=$1 and kind='reconciliation_mismatch'",[accepted.data.id])).map(r=>r.severity)).toEqual(["high","high"]);
 });

 it("notifies refund decisions, refund requests and runtime control changes in their own transactions",async()=>{
  const op=await operation(["awaiting_pix","pix_confirmed"]);
  const operator=randomUUID();
  await db.query(`insert into peragus_operator_refund_decisions(id,purchase_id,customer_id,operator_user_id,request_id,reason,from_status,environment)
   values($1,$2,$3,$4,$5,'Cliente pediu cancelamento após pagamento.','pix_confirmed','test')`,[randomUUID(),op.purchaseId,op.customer.id,operator,randomUUID()]);
  await repository.transitionOperation(op.purchaseId,"refund_pending",`operator:${operator}`,"OPERATOR_REFUND_DECISION: test");
  const rows=await forPurchase(op.purchaseId);
  expect(rows.map(r=>`${r.kind}:${r.recipient}`)).toEqual(["operator_refund_decision:operator","operator_refund_decision:trusted","refund_pending:operator","refund_pending:trusted"]);
  // The free-text operator reason is never copied into the e-mail payload.
  expect(JSON.stringify(rows.map(r=>r.payload))).not.toContain("Cliente pediu");
  const controls=new RuntimeControlService(pool,new Set([operator]),"test");
  await controls.set({id:operator,email:"o@example.test",assuranceLevel:"aal2",mfaVerifiedAt:Math.floor(Date.now()/1000)},"onboarding",false,"Pausa para manutenção do provedor.");
  const changes=await notes("kind='runtime_control_changed'");
  expect(changes.map(r=>[r.recipient,r.severity,r.payload.control_key,r.payload.to_enabled])).toEqual([["operator","high","onboarding",false],["trusted","high","onboarding",false]]);
  expect(JSON.stringify(changes.map(r=>r.payload))).not.toContain("manutenção");
  await enableRuntimeControls(db);
 });

 it("e-mails are pt-BR, carry operation id, kind and amounts, and no customer personal data",async()=>{
  await drainOperatorNotifications(pool,fakeSender().sender,config,1000);
  const op=await operation(until("approved"));
  const requests:{url:string;init:RequestInit}[]=[];
  const fetcher=(async(url:string,init:RequestInit)=>{requests.push({url,init});return new Response(JSON.stringify({id:`re-${requests.length}`}),{status:200});}) as unknown as typeof fetch;
  const sender=new ResendOperatorNotificationSender("re_test_synthetic",fetcher);
  expect(await drainOperatorNotifications(pool,sender,config)).toMatchObject({accepted:2});
  const rows=await forPurchase(op.purchaseId);
  expect(requests.map(r=>r.url)).toEqual(["https://api.resend.com/emails","https://api.resend.com/emails"]);
  const keys=requests.map(r=>(r.init.headers as Record<string,string>)["Idempotency-Key"]).sort();
  expect(keys).toEqual(rows.map(r=>r.idempotency_key).sort());
  for(const r of requests){
   const body=JSON.parse(String(r.init.body));
   expect(body.from).toBe("alertas@peragus.com.br");
   expect([config.recipients.operator,config.recipients.trusted]).toContain(body.to[0]);
   expect(body.subject).toBe(`[TESTES] [Peragus] Saque aprovado — operação ${op.purchaseId.slice(0,8)}`);
   expect(body.text).toContain(`Operação: ${op.purchaseId}`);
   expect(body.text).toContain("Tipo: Saque aprovado");
   expect(body.text).toContain("Valor: R$ 1000.00");
   expect(body.text).toContain("USDT travado: 200.000000");
   expect(body.text).toContain("Status: aprovada");
   expect(body.text).toContain("Transição: aguardando aprovação → aprovada");
   // Raw codes stay available to operators on one line.
   expect(body.text).toContain("Código: approval; status=approved; transição=awaiting_approval->approved");
   expect(body.text).not.toMatch(/^(Tipo|Status|Transição): .*(approval|approved)/m);
   for(const secret of ["Synthetic name",op.wallet,op.customer.id,op.owner,op.provider])expect(body.text+body.subject).not.toContain(secret);
  }
 });

 it("an invalid webhook signature notifies at most once per hour",async()=>{
  const app=await buildApp({customerWebhooks:{secret:"whsec_synthetic",mode:"test",processor:{process:async()=>"ignored"} as any,
   onSignatureInvalid:()=>recordWebhookSignatureInvalid(pool,"test")}});
  apps.push(app);
  for(let i=0;i<3;i++){
   const r=await app.inject({method:"POST",url:"/webhooks/customer-updates",headers:{"content-type":"application/json","x-ozav-signature":"t=1,v1=bad"},payload:"{}"});
   expect(r.statusCode).toBe(401);
  }
  expect((await notes("kind='webhook_signature_invalid'")).map(r=>[r.recipient,r.severity])).toEqual([["operator","high"],["trusted","high"]]);
 });

 it("daily_review_missing is raised once for a day with activity and no review",async()=>{
  const op=await operation();
  await db.query(`insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment,created_at)
   values($1,$2,'accepted','accepted','system:test','synthetic note','test',((now() at time zone 'America/Sao_Paulo')::date-6+time '12:00') at time zone 'America/Sao_Paulo')`,[op.purchaseId,op.customer.id]);
  const day=(await db.query<{d:string}>("select ((now() at time zone 'America/Sao_Paulo')::date-6)::text d")).rows[0]!.d;
  await scanner.scan(at(-5*24*60));await scanner.scan(at(-5*24*60+5));
  expect((await notes("kind='daily_review_missing'")).map(r=>[r.dedupe_key,r.payload.day])).toEqual([[`daily_review_missing:${day}`,day],[`daily_review_missing:${day}`,day]]);
 });

 it("outbox is environment-guarded, RLS-protected and its audit is immutable",async()=>{
  const op=await operation(until("approved"));
  const [row]=await forPurchase(op.purchaseId);
  await expect(db.query("delete from peragus_operator_notifications where id=$1",[row!.id])).rejects.toThrow("OPERATOR_NOTIFICATIONS_IMMUTABLE");
  await expect(db.query("update peragus_operator_notifications set payload='{}' where id=$1",[row!.id])).rejects.toThrow("OPERATOR_NOTIFICATIONS_IMMUTABLE");
  await expect(db.query("update peragus_operator_notifications set status='accepted',provider_email_id='x',accepted_at=now() where id=$1",[row!.id])).rejects.toThrow("OPERATOR_NOTIFICATIONS_IMMUTABLE");
  await expect(db.query("select peragus_enqueue_operator_notification('live','approval','info','x',null,'{}')")).rejects.toThrow("ENVIRONMENT_MISMATCH");
  const rls=await db.query("select relrowsecurity from pg_class where relname='peragus_operator_notifications'");
  expect(rls.rows).toEqual([{relrowsecurity:true}]);
  // The daily-review activity check has an (environment, created_at) index on the status log.
  const index=await db.query<{def:string}>("select indexdef def from pg_indexes where indexname='peragus_operation_status_events_environment_created'");
  expect(index.rows[0]?.def).toMatch(/peragus_operation_status_events .*\(environment, created_at\)/);
  const grants=await db.query("select grantee from information_schema.role_table_grants where table_name='peragus_operator_notifications' and grantee in ('anon','authenticated','PUBLIC')");
  expect(grants.rows).toEqual([]);
 });

 it("pending rows older than 48 h expire unsent, except high severity, and are counted by kind only",async()=>{
  await drainOperatorNotifications(pool,fakeSender().sender,config,1000);
  const old=async(kind:string,severity:string)=>{
   const key=`synthetic-old:${randomUUID()}`;
   await db.query(`insert into peragus_operator_notifications(id,environment,kind,severity,recipient,dedupe_key,payload,payload_hash,idempotency_key,created_at)
    select s.id,'test',$1,$2,'operator',$3,b.body,encode(sha256(convert_to(b.body::text,'UTF8')),'hex'),'peragus-operator-notification-test/'||s.id,now()-interval '49 hours'
    from (select gen_random_uuid() id) s,(select jsonb_build_object('kind',$1::text,'severity',$2::text,'environment','test') body) b`,[kind,severity,key]);
   return key;
  };
  const warn=await old("refund_pending","warn"),high=await old("stuck_operation","high");
  const sent=fakeSender();
  const result=await drainOperatorNotifications(pool,sent.sender,config);
  expect(result).toMatchObject({expired:1,expiredByKind:{"refund_pending:warn":1},accepted:1});
  expect(JSON.stringify(result)).not.toMatch(/@|synthetic-old/);
  expect((await notes("dedupe_key=any($1)",[[warn,high]])).map(r=>[r.kind,r.status])).toEqual([["refund_pending","failed"],["stuck_operation","accepted"]]);
  expect(sent.calls.map(c=>c.message.subject)).toEqual(["[TESTES] [Peragus] Operação parada"]);
 });

 it("a worst-case drain (every send timing out) fits the job expiry",()=>{
  expect(DRAIN_MAX*SEND_TIMEOUT_MS).toBeLessThanOrEqual(OPERATOR_JOB_EXPIRE_SECONDS*1000*0.75);
 });

 it("worker registers the outbox drain every minute and the stuck scanner every 5 minutes",async()=>{
  const schedules:[string,string][]=[],handlers=new Map<string,()=>Promise<unknown>>();
  const boss={createQueue:async()=>undefined,schedule:async(queue:string,cron:string)=>{schedules.push([queue,cron]);},
   work:async(queue:string,_options:unknown,handler:()=>Promise<unknown>)=>{handlers.set(queue,handler);return "w";}} as any;
  const logs:unknown[]=[];
  await registerOperatorNotificationJobs(boss,{drain:async()=>({accepted:1}),scan:async()=>({enqueued:2}),log:e=>logs.push(e)});
  expect(schedules).toEqual([[OPERATOR_NOTIFICATIONS_QUEUE,"* * * * *"],[STUCK_OPERATIONS_QUEUE,"*/5 * * * *"]]);
  await handlers.get(STUCK_OPERATIONS_QUEUE)!();await handlers.get(OPERATOR_NOTIFICATIONS_QUEUE)!();
  expect(logs).toEqual([{event:"stuck-operations_processed",enqueued:2},{event:"operator-notifications_processed",accepted:1}]);
 });

 it("configuration requires both recipients as e-mails and a @peragus.com.br sender, without echoing them",()=>{
  const base={OPERATOR_NOTIFICATIONS_ENABLED:"true",DATABASE_URL:"postgres://localhost/x",OPERATOR_NOTIFICATIONS_FROM:"alertas@peragus.com.br",
   OPERATOR_ALERT_EMAIL:"op-secret@example.test",TRUSTED_ALERT_EMAIL:"trusted-secret@example.test"};
  expect(envSchema.safeParse(base).success).toBe(true);
  expect(envSchema.safeParse({}).success).toBe(true);
  for(const bad of [{...base,TRUSTED_ALERT_EMAIL:undefined},{...base,OPERATOR_ALERT_EMAIL:"not-an-email"},{...base,OPERATOR_NOTIFICATIONS_FROM:"alertas@gmail.com"},
   {...base,TRUSTED_ALERT_EMAIL:"OP-SECRET@example.test"}]){
   const r=envSchema.safeParse(bad);
   expect(r.success).toBe(false);
   expect(JSON.stringify(r.error?.issues)).not.toMatch(/secret@|not-an-email|gmail/);
  }
  const env=envSchema.parse(base);
  expect(()=>operatorNotificationConfig(env,undefined)).toThrow("OPERATOR_NOTIFICATIONS_CONFIG_REQUIRED");
  expect(operatorNotificationConfig(env,"re_synthetic_key")).toMatchObject({mode:"test",from:"alertas@peragus.com.br",
   recipients:{operator:"op-secret@example.test",trusted:"trusted-secret@example.test"}});
 });
});
