import {z} from "zod";
import {providerKeyMatchesMode,type MoneyMode} from "../config/money-environment.js";
import {individualDraftSchema} from "../onboarding/individual-schema.js";
import {OzavClient, OzavClientError, httpsOzavTransport, httpsOzavWriteTransport,
 type OzavTransport, type OzavWriteTransport} from "./ozav-client.js";
/**
 * HTTP answers on which OZAV definitively refused the send: no transfer was created. 404 is not
 * one of them (a route or gateway answer says nothing about the transfer): it stays `sending`
 * and is recovered by GET.
 */
const DEFINITIVE_REFUSALS=new Set([400,401,403,422]);
export class SandboxWithdrawalProviderError extends OzavClientError {
 /** True when OZAV refused the request (400, 401, 403, 422): never re-POST, review instead. */
 readonly definitive:boolean;
 constructor(status:number,public readonly providerCode:string|null){
  super("Sandbox send outcome requires reconciliation",false,status);this.definitive=DEFINITIVE_REFUSALS.has(status);
 }
}
const errorCode=(body:unknown)=>{const e=(body as {error?:{code?:unknown}}|null)?.error;
 return typeof e?.code==="string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:null;};
const SOLANA_ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const pastTimestamp=(value:string)=>{const t=Date.parse(value);return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(t) && t<=Date.now();};
/** Accepted send: the OZAV transfer id and, when OZAV already reported it, the on-chain tx hash. */
export interface WithdrawalSendAccepted {id:string;txHash:string|null;}
const record=z.record(z.string(),z.unknown());
const id=(prefix:string)=>z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));
const decimal=z.string().regex(/^\d{1,15}(\.\d{1,6})?$/);
export const usdtUnits=(amount:string)=>{decimal.parse(amount);const [whole,fraction=""]=amount.split(".");return BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,"0"));};
export interface WithdrawalIdentity {name:string;cpf:string;street:string;city:string;country:"BR";}
export interface WithdrawalObservation {
 id:string;customerId:string;status:string;sourceWalletId:string;sourceCurrency:"USDT";
 destinationAddress:string;network:"solana";sourceAmount:string;targetAmount:string|null;
 sourceLegStatus:string|null;destinationLegStatus:string|null;
 transactionReference:string|null;
}
function observation(value:unknown):WithdrawalObservation {
 const row=record.parse(value),source=record.parse(row.source),dest=record.parse(row.destination),amounts=record.parse(row.amounts);
 const from=z.object({currency:z.literal("USDT"),amount:decimal}).parse(amounts.source);
 const to=amounts.target===undefined?null:z.object({currency:z.literal("USDT"),amount:decimal}).parse(amounts.target);
 if(row.object!=="transfer" || source.type!=="wallet" || source.currency!=="USDT"
  || (source.chain!=null && source.chain!=="solana") || dest.type!=="crypto_address"
  || dest.network!=="solana" || dest.currency!=="USDT" || row.quote_id!=null)throw new OzavClientError("Withdrawal context mismatch",false);
 const refs=row.settlement_references==null?{}:record.parse(row.settlement_references);
 if((refs.network!=null && refs.network!=="solana") || (refs.tx_hash!=null && refs.network!=="solana"))throw new OzavClientError("Withdrawal network mismatch",false);
 const leg=(v:unknown)=>v==null?null:z.string().min(1).max(80).nullable().parse(record.parse(v).status??null);
 return {id:id("ozav_tr_").parse(row.id),customerId:id("ozav_cus_").parse(row.customer_id),
  status:z.enum(["awaiting_payment","payment_confirmed","converting","payout_initiated","completed","failed","cancelled","expired","needs_review","awaiting_approval"]).parse(row.status),
  sourceWalletId:id("ozav_wal_").parse(source.wallet_id),sourceCurrency:"USDT",destinationAddress:z.string().min(32).max(44).parse(dest.address),network:"solana",
  sourceAmount:from.amount,targetAmount:to?.amount??null,sourceLegStatus:leg(row.source_leg),destinationLegStatus:leg(row.destination_leg),
  transactionReference:refs.tx_hash==null?null:z.string().min(1).max(256).parse(refs.tx_hash)};
}
/** A separate send boundary bound to one money mode (key and capabilities); no generic POST retry. */
export class OzavSandboxWithdrawalProvider {
 readonly funding:OzavClient;
 private readonly read:OzavTransport;private readonly write:OzavWriteTransport;
 readonly mode:MoneyMode;
 constructor(private readonly key:string,options:{mode:MoneyMode;read?:OzavTransport;write?:OzavWriteTransport}){
  if(!providerKeyMatchesMode(key,options.mode))throw new OzavClientError("Sandbox key required",false);
  this.mode=options.mode;
  this.read=options.read??httpsOzavTransport;this.write=options.write??httpsOzavWriteTransport;
  this.funding=new OzavClient({apiKey:key,mode:options.mode,transport:this.read,attempts:1,timeoutMs:10000});
 }
 private async get(path:string){const r=await this.read(path,this.key,10000);if(r.statusCode!==200)throw new OzavClientError("Withdrawal read unavailable",false,r.statusCode);return record.parse(r.body);}
 async capabilities(){const c=await this.get("/v2/capabilities");const scopes=z.array(z.string()).parse(c.scopes),entitlements=z.array(z.string()).parse(c.entitlements),features=record.parse(c.features);
  if(c.environment!==this.mode || !["liquidity","custody","customers"].every(v=>entitlements.includes(v))
   || !["customers:read","customers:write","wallets:read","transfers:read","transfers:write"].every(v=>scopes.includes(v))
   || features.transfers!=="live" || features.wallet_transfers!=="live")throw new OzavClientError("Withdrawal capabilities missing",false);
 }
 async identity(customerId:string,externalRef:string):Promise<WithdrawalIdentity>{
  const c=await this.get(`/v2/customers/${encodeURIComponent(id("ozav_cus_").parse(customerId))}`);
  const verification=record.parse(c.verification),requirements=record.parse(c.requirements);
  if(c.id!==customerId || c.object!=="customer" || c.type!=="individual" || c.external_ref!==externalRef
   || c.status!=="approved" || c.account_status!=="active" || verification.mode!=="full"
   || !["due","due_codes","missing_fields","documents_due"].every(k=>Array.isArray(requirements[k]) && (requirements[k] as unknown[]).length===0))throw new OzavClientError("Customer not ready",false);
  const p=record.parse(c.individual),tax=record.parse(p.tax_id),address=record.parse(p.residential_address);
  if(tax.type!=="cpf" || tax.country!=="BR" || address.country!=="BR")throw new OzavClientError("Identity requirements missing",false);
  const text=z.string().trim().min(1).max(200),cpf=individualDraftSchema().shape.cpf.parse(tax.value);
  const street=text.parse(address.line1),number=text.parse(address.number);
  return {name:z.string().trim().min(2).max(160).parse(p.legal_name),cpf,street:`${street}, ${number}`,city:text.parse(address.city),country:"BR"};
 }
 async available(customerId:string,walletId:string):Promise<string>{
  const w=await this.get(`/v2/wallets/${encodeURIComponent(id("ozav_wal_").parse(walletId))}`);
  if(w.id!==walletId || w.customer_id!==customerId || w.custody_model!=="managed" || w.status!=="active")throw new OzavClientError("Wallet binding mismatch",false);
  const page=await this.get(`/v2/wallets/${encodeURIComponent(walletId)}/balances`);
  const balances=z.array(z.object({currency:z.string(),amount:z.string()})).parse(page.data).filter(b=>b.currency==="USDT");
  if(balances.length!==1)throw new OzavClientError("USDT balance unknown",false);
  return decimal.parse(balances[0]!.amount);
 }
 /**
  * Registers who holds the destination wallet (the customer's own, self-custodied, attested by the
  * wallet proof) before a crypto_address send. OZAV records a new identification per POST and the
  * latest applies, so a repeat is harmless; 409 (already identified) counts as success.
  */
 async identifyDestination(customerId:string,address:string,attestedAt:string):Promise<void>{
  id("ozav_cus_").parse(customerId);
  if(!SOLANA_ADDRESS.test(address) || !pastTimestamp(attestedAt))throw new OzavClientError("Invalid destination identification input",false);
  const r=await this.write({path:`/v2/customers/${encodeURIComponent(customerId)}/destination-identifications`,
   body:{chain:"solana",address,wallet_type:"self_custodied",wallet_attested_ownership_at:attestedAt}},this.key,15000);
  if(r.statusCode===200 || r.statusCode===201 || r.statusCode===409)return;
  throw new OzavClientError("Destination identification refused",false,r.statusCode);
 }
 async send(input:{executionId:string;withdrawalId:string;customerId:string;walletId:string;amount:string;address:string;verifiedAt:string;identity:WithdrawalIdentity}):Promise<WithdrawalSendAccepted>{
  z.string().uuid().parse(input.executionId);z.string().uuid().parse(input.withdrawalId);
  id("ozav_cus_").parse(input.customerId);id("ozav_wal_").parse(input.walletId);
  if(usdtUnits(input.amount)<=0n || !SOLANA_ADDRESS.test(input.address)
   || !Number.isFinite(Date.parse(input.verifiedAt)) || Date.parse(input.verifiedAt)>Date.now())throw new OzavClientError("Invalid sandbox send input",false);
  const i=input.identity;
  const r=await this.write({path:"/v2/transfers",idempotencyKey:`peragus-send-${input.executionId}`,body:{
   customer_id:input.customerId,amount:{currency:"USDT",amount:input.amount},
   source:{type:"wallet",wallet_id:input.walletId,currency:"USDT",chain:"solana"},
   destination:{type:"crypto_address",address:input.address,network:"solana",currency:"USDT"},
   travel_rule:{originator:{name:i.name,identity_documents:[{type:"cpf",number:i.cpf,issuing_country:"BR"}],address:{street_line_1:i.street,city:i.city,country:i.country}},
    beneficiary:{name:i.name,wallet_type:"self_custodied",wallet_attested_ownership_at:input.verifiedAt,is_self:true}},
   metadata:{peragus_execution_id:input.executionId,peragus_withdrawal_request_id:input.withdrawalId}
  }},this.key,15000);
  if(r.statusCode!==200 && r.statusCode!==201)throw new SandboxWithdrawalProviderError(r.statusCode,errorCode(r.body));
  const body=record.parse(r.body);if(body.object!=="transfer")throw new OzavClientError("Send outcome invalid",false);
  // Retain reduced HTTP 200 IDs; only a later GET supplies persisted evidence.
  const refs=body.settlement_references==null?null:record.safeParse(body.settlement_references);
  const hash=refs?.success && refs.data.network==="solana" && typeof refs.data.tx_hash==="string" && /^[!-~]{1,256}$/.test(refs.data.tx_hash)?refs.data.tx_hash:null;
  return {id:id("ozav_tr_").parse(body.id),txHash:hash};
 }
 async transfer(transferId:string){return observation(await this.get(`/v2/transfers/${encodeURIComponent(id("ozav_tr_").parse(transferId))}`));}
 async find(customerId:string,executionId:string):Promise<string|null>{
  id("ozav_cus_").parse(customerId);let cursor:string|undefined;const matches=new Set<string>();
  for(let page=0;page<20;page++){
   const query=new URLSearchParams({customer_id:customerId,limit:"100"});if(cursor)query.set("starting_after",cursor);
   const row=await this.get(`/v2/transfers?${query}`),data=z.array(record).parse(row.data);if(typeof row.has_more!=="boolean")throw new OzavClientError("Incomplete listing",false);
   for(const item of data){if(item.customer_id!==customerId)throw new OzavClientError("Foreign listing result",false);if(item.metadata!=null && record.parse(item.metadata).peragus_execution_id===executionId)matches.add(id("ozav_tr_").parse(item.id));}
   if(!row.has_more){if(matches.size>1)throw new OzavClientError("Ambiguous recovery",false);return [...matches][0]??null;}
   const next=z.string().min(1).max(4096).parse(row.next_cursor);if(next===cursor)throw new OzavClientError("Repeated cursor",false);cursor=next;
  }
  throw new OzavClientError("Incomplete listing",false);
 }
}
