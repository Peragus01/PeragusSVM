import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import type {OzavIndicativeQuote} from "../providers/ozav-client.js";
import {CustomerQuoteError,type CustomerQuoteRepository,type CustomerQuoteRecord} from "../quotes/customer-quotes.js";
interface Row {id:string;customer_id:string;request_id:string;provider_customer_id:string;source_amount_brl:string;
  create_attempted:boolean;observation:OzavIndicativeQuote|null;created_at:Date|string;}
const map=(r:Row):CustomerQuoteRecord=>({id:r.id,customerId:r.customer_id,requestId:r.request_id,providerCustomerId:r.provider_customer_id,
  amountBrl:r.source_amount_brl,attempted:r.create_attempted,quote:r.observation,createdAt:new Date(r.created_at).toISOString()});
export class PostgresCustomerQuoteRepository implements CustomerQuoteRepository {
  constructor(private readonly pool:Pool){}
  async findRequest(customerId:string,requestId:string){
    const r=await this.pool.query<Row>("select * from peragus_customer_indicative_quotes where customer_id=$1 and request_id=$2 and environment='test'",[customerId,requestId]);return r.rows[0]?map(r.rows[0]):null;
  }
  async findOwned(customerId:string,id:string){
    const r=await this.pool.query<Row>("select * from peragus_customer_indicative_quotes where customer_id=$1 and id=$2 and environment='test'",[customerId,id]);return r.rows[0]?map(r.rows[0]):null;
  }
  async reserve(customerId:string,requestId:string,providerCustomerId:string,amountBrl:string){
    await this.pool.query("insert into peragus_customer_indicative_quotes(id,customer_id,request_id,provider_customer_id,source_amount_brl) values($1,$2,$3,$4,$5) on conflict(customer_id,request_id) do nothing",[randomUUID(),customerId,requestId,providerCustomerId,amountBrl]);
    const row=await this.findRequest(customerId,requestId);
    if(!row || row.providerCustomerId!==providerCustomerId || row.amountBrl!==amountBrl)throw new CustomerQuoteError("QUOTE_IDEMPOTENCY_CONFLICT");return row;
  }
  async claim(id:string){
    const r=await this.pool.query("update peragus_customer_indicative_quotes set create_attempted=true,updated_at=now() where id=$1 and environment='test' and not create_attempted returning id",[id]);return Boolean(r.rows[0]);
  }
  async save(row:CustomerQuoteRecord,quote:OzavIndicativeQuote){
    if(quote.customerId!==row.providerCustomerId || quote.source.amount!==row.amountBrl || quote.source.currency!=="BRL" || quote.target.currency!=="USDT"
      || quote.rateType!=="floating" || quote.expiresAt!==null || quote.spreadBps!==0)throw new CustomerQuoteError("QUOTE_CONFLICT",row.id);
    try {
      const r=await this.pool.query<Row>(`update peragus_customer_indicative_quotes set provider_quote_id=$3,observation=$4::jsonb,updated_at=now()
        where id=$1 and customer_id=$2 and provider_customer_id=$5 and environment='test' and create_attempted and provider_quote_id is null returning *`,
        [row.id,row.customerId,quote.id,JSON.stringify(quote),row.providerCustomerId]);
      if(!r.rows[0])throw new CustomerQuoteError("QUOTE_CONFLICT",row.id);return map(r.rows[0]);
    }catch(error){if((error as {code?:string}).code==="23505")throw new CustomerQuoteError("QUOTE_CONFLICT",row.id);throw error;}
  }
}
