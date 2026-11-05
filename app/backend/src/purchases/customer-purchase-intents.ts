export interface PurchaseIntent {
  id:string;customerId:string;requestId:string;quoteId:string;sourceAmountBrl:string;
  estimatedTargetAmountUsdt:string;quoteSnapshot:{rate:string;rate_type:"floating";quoted_at:string;
    exchange_conditions:{spread_bps:number;rate_without_spread:string|null;amount_deducted:string|null}};
  walletAddress:string;walletVerifiedAt:string;createdAt:string;
}
export class PurchaseIntentError extends Error {
  constructor(public readonly code:"PURCHASE_INTENT_NOT_FOUND"|"PURCHASE_QUOTE_NOT_FOUND"|"PURCHASE_IDEMPOTENCY_CONFLICT"|"PURCHASE_QUOTE_ALREADY_RECORDED"|"PURCHASE_PREREQUISITES_NOT_RECORDED"){super(code);}
}
export interface PurchaseIntentRepository {
  read(customerId:string,id:string):Promise<PurchaseIntent|null>;
  record(customerId:string,requestId:string,quoteId:string):Promise<{record:PurchaseIntent;replayed:boolean}>;
}
const view=(r:PurchaseIntent)=>({id:r.id,request_id:r.requestId,quote_id:r.quoteId,state:"recorded",record_only:true,
  source:{currency:"BRL",amount:r.sourceAmountBrl},estimated_target:{currency:"USDT",amount:r.estimatedTargetAmountUsdt,chain:"solana"},
  quote_reference:r.quoteSnapshot,destination:{wallet_address:r.walletAddress,proof_network:"solana:devnet",verified_at:r.walletVerifiedAt},
  created_at:r.createdAt,environment:"test",indicative:true,executable:false,
  observation_freshness:"not_evaluated",external_delivery_costs_evaluated:false,
  funding_started:false,job_enqueued:false,operations_enabled:false});
export class CustomerPurchaseIntentService {
  constructor(private readonly repository:PurchaseIntentRepository){}
  async read(customerId:string,id:string){const record=await this.repository.read(customerId,id);if(!record)throw new PurchaseIntentError("PURCHASE_INTENT_NOT_FOUND");return view(record);}
  async record(customerId:string,requestId:string,quoteId:string){const result=await this.repository.record(customerId,requestId,quoteId);return{data:view(result.record),replayed:result.replayed};}
}
