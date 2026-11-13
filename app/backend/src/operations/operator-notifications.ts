import type {Pool} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment} from "../repositories/row-environment.js";

/**
 * Operator + trusted-person e-mail alerts (migration 055, Task 17).
 *
 * Enqueueing: money-relevant events are enqueued by database triggers on their own audit
 * rows (same transaction as the status transition / decision / control change); the
 * time-based thresholds by StuckOperationScanner (src/jobs/stuck-operations.ts). Each
 * event becomes one outbox row per recipient role ('operator', 'trusted').
 *
 * Delivery copies the invite outbox (src/invites/invite-email-processor.ts): a stable
 * Idempotency-Key per row, the attempt recorded (autocommit) before the HTTP call, an
 * ambiguous outcome ends as 'uncertain' and is never retried automatically, a definitive
 * provider refusal ends as 'failed'. Addresses come from configuration, never from the
 * database, and are never logged.
 */
export const OPERATOR_NOTIFICATION_KINDS=["approval","execution","needs_review","refund_pending","refund_completed",
 "operator_refund_decision","runtime_control_changed","stuck_operation","webhook_signature_invalid",
 "reconciliation_mismatch","pix_open_after_close","withdrawal_refused_transfer_found","daily_review_missing"] as const;
export type OperatorNotificationKind=(typeof OPERATOR_NOTIFICATION_KINDS)[number];

export interface OperatorNotificationConfig {
 mode:MoneyMode;
 /** Sender on @peragus.com.br. */
 from:string;
 recipients:{operator:string;trusted:string};
}
export interface OperatorNotificationMessage {from:string;to:string[];subject:string;text:string}
export interface OperatorNotificationSender {
 /** Returns the provider e-mail id; throws OperatorNotificationSendError. */
 send(idempotencyKey:string,message:OperatorNotificationMessage):Promise<string>;
}
export class OperatorNotificationSendError extends Error {
 constructor(readonly definitive:boolean){super("OPERATOR_NOTIFICATION_PROVIDER_UNCONFIRMED");}
}

const EMAIL=/^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/**
 * Worker configuration from the validated env plus the Resend key. Throws
 * OPERATOR_NOTIFICATIONS_CONFIG_REQUIRED (naming no value) when anything is missing.
 */
export function operatorNotificationConfig(env:{PERAGUS_DEPLOYMENT_ENV:"staging"|"production";OPERATOR_ALERT_EMAIL?:string|undefined;
 TRUSTED_ALERT_EMAIL?:string|undefined;OPERATOR_NOTIFICATIONS_FROM?:string|undefined},resendApiKey:string|undefined):OperatorNotificationConfig&{apiKey:string}{
 const operator=env.OPERATOR_ALERT_EMAIL,trusted=env.TRUSTED_ALERT_EMAIL,from=env.OPERATOR_NOTIFICATIONS_FROM;
 if(!operator || !trusted || !from || !EMAIL.test(operator) || !EMAIL.test(trusted) || !EMAIL.test(from)
  || operator.toLowerCase()===trusted.toLowerCase() || !from.toLowerCase().endsWith("@peragus.com.br")
  || !resendApiKey || !/^re_[A-Za-z0-9_]+$/.test(resendApiKey))
  throw new Error("OPERATOR_NOTIFICATIONS_CONFIG_REQUIRED");
 return{mode:env.PERAGUS_DEPLOYMENT_ENV==="production"?"live":"test",from,recipients:{operator,trusted},apiKey:resendApiKey};
}

/** Resend sender for the operator alerts (separate from the invite and onboarding senders). */
export class ResendOperatorNotificationSender implements OperatorNotificationSender {
 constructor(private readonly apiKey:string,private readonly fetcher:typeof fetch=fetch){}
 async send(idempotencyKey:string,message:OperatorNotificationMessage):Promise<string>{
  let response:Response;
  try{
   response=await this.fetcher("https://api.resend.com/emails",{method:"POST",
    headers:{Authorization:`Bearer ${this.apiKey}`,"Content-Type":"application/json","Idempotency-Key":idempotencyKey},
    body:JSON.stringify(message),redirect:"error",signal:AbortSignal.timeout(10000)});
  }catch{throw new OperatorNotificationSendError(false);}
  if(!response.ok)throw new OperatorNotificationSendError([400,401,403,404,422].includes(response.status));
  try{
   const data=(await response.json()) as {id?:unknown};
   if(typeof data.id!=="string" || !/^[a-zA-Z0-9-]{1,100}$/.test(data.id))throw new Error();
   return data.id;
  }catch{throw new OperatorNotificationSendError(false);}
 }
}

const TITLES:Record<OperatorNotificationKind,string>={
 approval:"Saque aprovado",execution:"Envio de USDT",needs_review:"Operação em revisão",refund_pending:"Reembolso pendente",
 refund_completed:"Reembolso registrado",operator_refund_decision:"Decisão de reembolso",runtime_control_changed:"Chave operacional alterada",
 stuck_operation:"Operação parada",webhook_signature_invalid:"Webhook com assinatura inválida",reconciliation_mismatch:"Divergência na conciliação",
 pix_open_after_close:"Pix em aberto após encerramento",withdrawal_refused_transfer_found:"Envio recusado com transferência encontrada",
 daily_review_missing:"Revisão diária pendente",
};
const SEVERITY:Record<string,string>={high:"alta",warn:"atenção",info:"informativa"};
const THRESHOLDS:Record<string,string>={sending_30m:"em envio há mais de 30 min",sent_30m_unverified:"enviada há mais de 30 min sem verificação on-chain",
 awaiting_pix_expired:"aguardando Pix após o prazo (expiração do Pix ou da trava)","4h":"há mais de 4 h","12h":"há mais de 12 h","20h":"há mais de 20 h"};
const CONTROLS:Record<string,string>={new_operations:"novas operações",usdt_sends:"envios de USDT",onboarding:"cadastro"};

/** Only whitelisted payload fields are rendered, each reduced to a short safe token. */
function field(value:unknown,pattern:RegExp):string|null{
 if(typeof value!=="string" && typeof value!=="number" && typeof value!=="boolean")return null;
 const text=String(value);
 return text.length<=64 && pattern.test(text)?text:null;
}
const ID=/^[0-9a-f-]{36}$/,TOKEN=/^[A-Za-z0-9_:.+-]{1,64}$/,AMOUNT=/^\d{1,15}(?:\.\d{1,6})?$/,DAY=/^\d{4}-\d{2}-\d{2}$/;

/**
 * Plain-text pt-BR e-mail. Operation id, kind, severity, statuses and amounts only: never
 * a customer name, document, e-mail, wallet address or free-text reason.
 */
export function renderOperatorNotification(payload:Record<string,unknown>,mode:MoneyMode):{subject:string;text:string}{
 const kind=OPERATOR_NOTIFICATION_KINDS.find(k=>k===payload.kind);
 if(!kind)throw new Error("OPERATOR_NOTIFICATION_PAYLOAD_INVALID");
 const purchase=field(payload.purchase_id,ID),day=field(payload.day,DAY),threshold=field(payload.threshold,TOKEN);
 let title=TITLES[kind];
 if(kind==="execution" && payload.to_status==="delivered_verified")title="Entrega de USDT verificada";
 else if(kind==="execution")title="Envio de USDT iniciado";
 const subject=`${mode==="test"?"[TESTES] ":""}[Peragus] ${title}${purchase?` — operação ${purchase.slice(0,8)}`:day?` — ${day}`:""}`;
 const lines=[`Alerta Peragus — ambiente: ${mode==="live"?"produção":"testes"}`,"",
  `Tipo: ${kind}`,`Gravidade: ${SEVERITY[String(payload.severity)]??"informativa"}`];
 if(purchase)lines.push(`Operação: ${purchase}`);
 const status=field(payload.status,TOKEN),from=field(payload.from_status,TOKEN),to=field(payload.to_status,TOKEN);
 if(status)lines.push(`Status: ${status}`);
 if(to)lines.push(`Transição: ${from??"—"} → ${to}`);
 const reason=field(payload.reason_code,/^[A-Z][A-Z0-9_]{2,63}$/);if(reason)lines.push(`Código do motivo: ${reason}`);
 const brl=field(payload.source_amount_brl,AMOUNT);if(brl)lines.push(`Valor: R$ ${brl}`);
 const usdt=field(payload.locked_usdt_amount,AMOUNT);if(usdt)lines.push(`USDT travado: ${usdt}`);
 const refund=field(payload.refund_amount_brl,AMOUNT);if(refund)lines.push(`Valor do reembolso: R$ ${refund}`);
 const refunded=field(payload.refunded_amount_brl,AMOUNT);if(refunded)lines.push(`Valor devolvido: R$ ${refunded}`);
 const decision=field(payload.decision,/^(refund|approved|rejected)$/);
 if(decision)lines.push(`Decisão: ${decision==="refund"?"reembolsar a operação":decision==="approved"?"reembolso aprovado":"reembolso rejeitado"}`);
 const refundRequest=field(payload.refund_request_id,ID);if(refundRequest)lines.push(`Pedido de reembolso: ${refundRequest}`);
 if(threshold)lines.push(`Limite atingido: ${THRESHOLDS[threshold]??threshold}`);
 const control=field(payload.control_key,TOKEN);
 if(control)lines.push(`Chave: ${CONTROLS[control]??control} — ${payload.to_enabled===true?"ligada":"desligada"} (antes ${payload.from_enabled===true?"ligada":"desligada"})`);
 if(day)lines.push(`Dia: ${day}${kind==="daily_review_missing"?" — novas operações ficam bloqueadas até a revisão":""}`);
 const resource=field(payload.resource_id,ID);if(resource)lines.push(`Registro: ${resource}`);
 const when=field(payload.event_at,/^[0-9T:.+\- Z]{10,40}$/);if(when)lines.push(`Registrado em: ${when}`);
 lines.push("","Detalhes no painel do operador. Este e-mail não contém dados pessoais do cliente.",
  "Enviado ao operador e à pessoa de confiança.");
 return{subject,text:lines.join("\n")};
}

interface Claimed {id:string;recipient:"operator"|"trusted";payload:Record<string,unknown>;idempotency_key:string;intact:boolean}
export type ProcessOutcome="idle"|"accepted"|"failed"|"uncertain";

/**
 * Sends at most one pending notification. Concurrent workers are safe: the claim is a
 * single `for update skip locked` UPDATE (autocommit) that records the attempt before
 * the HTTP call.
 */
export async function processOperatorNotification(pool:Pick<Pool,"query">,sender:OperatorNotificationSender,config:OperatorNotificationConfig):Promise<ProcessOutcome>{
 const e=rowEnvironment(config.mode);
 const claim=await pool.query<Claimed>(`update peragus_operator_notifications n set status='sending',attempts=1,
   first_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
  where n.id=(select id from peragus_operator_notifications where environment='${e.mode}' and status='pending'
   order by created_at,id for update skip locked limit 1)
  returning n.id,n.recipient,n.payload,n.idempotency_key,encode(sha256(convert_to(n.payload::text,'UTF8')),'hex')=n.payload_hash as intact`);
 const row=claim.rows[0];
 if(!row)return "idle";
 const finish=async(status:"failed"|"uncertain",error:string)=>{
  await pool.query(`update peragus_operator_notifications set status=$2,last_error=$3,updated_at=clock_timestamp() where id=$1 and status='sending'`,[row.id,status,error]);
  return status;
 };
 let message:OperatorNotificationMessage;
 try{
  if(!row.intact)throw new Error();
  const rendered=renderOperatorNotification(row.payload,config.mode);
  message={from:config.from,to:[config.recipients[row.recipient]],...rendered};
 }catch{return finish("failed","PAYLOAD_INVALID");}
 if(!message.to[0])return finish("failed","RECIPIENT_UNCONFIGURED");
 let providerId:string;
 try{providerId=await sender.send(row.idempotency_key,message);}
 catch(error){
  // Only a definitive provider refusal is 'failed'; anything else may have been delivered.
  return error instanceof OperatorNotificationSendError && error.definitive?finish("failed","PROVIDER_REJECTED"):finish("uncertain","PROVIDER_UNCONFIRMED");
 }
 await pool.query(`update peragus_operator_notifications set status='accepted',provider_email_id=$2,accepted_at=clock_timestamp(),last_error=null,
  updated_at=clock_timestamp() where id=$1 and status='sending'`,[row.id,providerId]);
 return "accepted";
}

/** Rows left 'sending' this long were interrupted mid-call (the HTTP timeout is 10 s). */
export const SENDING_INTERRUPTED_AFTER="5 minutes";
/** Pending rows older than this are not e-mailed (e.g. enqueued while the worker was off). */
export const PENDING_EXPIRES_AFTER="48 hours";

/** One worker cycle: closes interrupted/expired rows, then sends up to `max` notifications. */
export async function drainOperatorNotifications(pool:Pick<Pool,"query">,sender:OperatorNotificationSender,config:OperatorNotificationConfig,max=50){
 const e=rowEnvironment(config.mode);
 // An interrupted attempt may have reached the provider: uncertain, never re-sent.
 const interrupted=await pool.query(`update peragus_operator_notifications set status='uncertain',last_error='PROVIDER_UNCONFIRMED',updated_at=clock_timestamp()
  where environment='${e.mode}' and status='sending' and updated_at<clock_timestamp()-interval '${SENDING_INTERRUPTED_AFTER}' returning id`);
 const expired=await pool.query(`update peragus_operator_notifications set status='failed',last_error='EXPIRED_UNSENT',updated_at=clock_timestamp()
  where environment='${e.mode}' and status='pending' and created_at<clock_timestamp()-interval '${PENDING_EXPIRES_AFTER}' returning id`);
 const counts={accepted:0,failed:0,uncertain:interrupted.rows.length,expired:expired.rows.length};
 for(let i=0;i<max;i++){
  const outcome=await processOperatorNotification(pool,sender,config);
  if(outcome==="idle")break;
  counts[outcome]++;
 }
 return counts;
}

/**
 * Enqueues an event that has no database write of its own (idempotent per dedupe key).
 * Returns the number of rows inserted.
 */
export async function enqueueOperatorNotification(q:Pick<Pool,"query">,mode:MoneyMode,input:{kind:OperatorNotificationKind;
 severity:"info"|"warn"|"high";dedupeKey:string;purchaseId?:string|null;payload?:Record<string,unknown>}):Promise<number>{
 const e=rowEnvironment(mode);
 const r=await q.query<{n:number}>("select peragus_enqueue_operator_notification($1,$2,$3,$4,$5,$6) as n",
  [e.mode,input.kind,input.severity,input.dedupeKey,input.purchaseId??null,JSON.stringify(input.payload??{})]);
 return Number(r.rows[0]?.n??0);
}

/** An OZAV webhook failed signature verification: one e-mail pair per UTC hour at most. */
export async function recordWebhookSignatureInvalid(q:Pick<Pool,"query">,mode:MoneyMode,now:Date=new Date()):Promise<number>{
 const hour=now.toISOString().slice(0,13);
 return enqueueOperatorNotification(q,mode,{kind:"webhook_signature_invalid",severity:"high",dedupeKey:`webhook_signature_invalid:${hour}`,
  payload:{event_at:`${hour}:00Z`}});
}
