import type {OzavClient,OzavIndicativeQuote} from "../providers/ozav-client.js";
import {OzavClientError} from "../providers/ozav-client.js";
import {onboardingExternalRef,type SubmissionRepository} from "../onboarding/submission-types.js";
export function normalizeQuoteBrl(value:string):string {
  if(!/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value))throw new CustomerQuoteError("QUOTE_AMOUNT_INVALID");
  const [whole,fraction=""]=value.split("."),cents=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,"0"));
  if(cents<=0n || cents>1000000n)throw new CustomerQuoteError("QUOTE_AMOUNT_INVALID");
  return `${whole}.${fraction.padEnd(2,"0")}`;
}
export interface CustomerQuoteRecord {
  id:string;customerId:string;requestId:string;providerCustomerId:string;amountBrl:string;
  attempted:boolean;quote:OzavIndicativeQuote|null;createdAt:string;
}
export interface CustomerQuoteRepository {
  findRequest(customerId:string,requestId:string):Promise<CustomerQuoteRecord|null>;
  findOwned(customerId:string,id:string):Promise<CustomerQuoteRecord|null>;
  reserve(customerId:string,requestId:string,providerCustomerId:string,amountBrl:string):Promise<CustomerQuoteRecord>;
  claim(id:string):Promise<boolean>;
  save(row:CustomerQuoteRecord,quote:OzavIndicativeQuote):Promise<CustomerQuoteRecord>;
}
export class CustomerQuoteError extends Error {
  constructor(public readonly code:"QUOTE_AMOUNT_INVALID"|"QUOTE_CUSTOMER_REQUIRED"|"QUOTE_CUSTOMER_NOT_READY"|"QUOTE_CAPABILITY_REQUIRED"|"QUOTE_IDEMPOTENCY_CONFLICT"|"QUOTE_RECOVERY_REQUIRED"|"QUOTE_NOT_FOUND"|"QUOTE_CONFLICT",public readonly quoteId?:string){super(code);}
}
export class CustomerQuoteProviderError extends Error {
  constructor(public readonly quoteId:string,public readonly providerStatus:number|null){super("QUOTE_PROVIDER_UNAVAILABLE");}
}
const view=(r:CustomerQuoteRecord)=>({id:r.id,request_id:r.requestId,state:r.quote?"quoted":"uncertain",
  source:{currency:"BRL",amount:r.amountBrl},target:r.quote?{currency:"USDT",amount:r.quote.target.amount,chain:"solana"}:null,
  rate:r.quote?.rate??null,rate_type:r.quote?.rateType??null,
  exchange_conditions:r.quote?{spread_bps:r.quote.spreadBps,rate_without_spread:r.quote.rateWithoutSpread,amount_deducted:r.quote.amountDeducted}:null,
  expires_at:r.quote?.expiresAt??null,quoted_at:r.quote?.createdAt??null,recorded_at:r.createdAt,
  environment:"test",indicative:true,executable:false,pricing_scope:"conversion_estimate",
  external_delivery_costs_evaluated:false,operations_enabled:false});
export class CustomerQuoteService {
  constructor(private readonly repository:CustomerQuoteRepository,private readonly submissions:SubmissionRepository,
    private readonly provider:Pick<OzavClient,"getCustomerCapabilities"|"getSandboxCustomerSnapshot"|"createCustomerIndicativeQuote">){}
  private check(row:CustomerQuoteRecord,providerCustomerId:string,amountBrl:string){
    if(row.providerCustomerId!==providerCustomerId || row.amountBrl!==amountBrl)throw new CustomerQuoteError("QUOTE_IDEMPOTENCY_CONFLICT",row.id);
  }
  async read(customerId:string,id:string){
    const row=await this.repository.findOwned(customerId,id);if(!row)throw new CustomerQuoteError("QUOTE_NOT_FOUND");return view(row);
  }
  async create(customerId:string,requestId:string,inputAmount:string){
    const amountBrl=normalizeQuoteBrl(inputAmount),binding=await this.submissions.find(customerId);
    if(!binding || binding.state!=="linked" || !binding.providerId)throw new CustomerQuoteError("QUOTE_CUSTOMER_REQUIRED");
    const prior=await this.repository.findRequest(customerId,requestId);
    if(prior){this.check(prior,binding.providerId,amountBrl);if(prior.quote)return{data:view(prior),replayed:true};}
    // Never repeat a quote POST with unknown outcome: this provider operation has
    // no documented idempotency key or quote-list reconciliation endpoint.
    if(prior?.attempted)throw new CustomerQuoteError("QUOTE_RECOVERY_REQUIRED",prior.id);
    const caps=await this.provider.getCustomerCapabilities();
    if(caps.environment!=="test" || !["customers","liquidity"].every(v=>caps.entitlements.includes(v))
      || !["customers:read","quotes:write"].every(v=>caps.scopes.includes(v)))throw new CustomerQuoteError("QUOTE_CAPABILITY_REQUIRED");
    const customer=await this.provider.getSandboxCustomerSnapshot(binding.providerId,onboardingExternalRef(customerId));
    if(customer.provider_status!=="approved" || customer.verification_mode!=="full" || customer.requirements_pending!==false)throw new CustomerQuoteError("QUOTE_CUSTOMER_NOT_READY");
    const row=await this.repository.reserve(customerId,requestId,binding.providerId,amountBrl);
    this.check(row,binding.providerId,amountBrl);
    if(row.quote)return{data:view(row),replayed:true};
    if(!await this.repository.claim(row.id))throw new CustomerQuoteError("QUOTE_RECOVERY_REQUIRED",row.id);
    let quote:OzavIndicativeQuote;
    try{quote=await this.provider.createCustomerIndicativeQuote(binding.providerId,amountBrl);}
    catch(error){if(error instanceof OzavClientError)throw new CustomerQuoteProviderError(row.id,error.statusCode??null);throw error;}
    return{data:view(await this.repository.save(row,quote)),replayed:false};
  }
}
