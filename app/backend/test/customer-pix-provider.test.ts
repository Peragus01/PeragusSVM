import {describe,it,expect,vi} from "vitest";
import {OzavClient,OzavFacilityLockRefusedError} from "../src/providers/ozav-client.js";
const customer="ozav_cus_testcustomer",wallet="ozav_wal_testwallet",id="ozav_tr_testtransfer";
const input={customerId:customer,walletId:wallet,quoteId:"ozav_q_testquote",idempotencyKey:"peragus-pix-12345678-1234-4234-8234-123456789abc",metadata:{peragus_pix_id:"local"}};
describe("customer Pix OZAV protocol",()=>{
 it("keeps the reduced 200 transfer ID without attempting to parse a full resource",async()=>{
  const write=vi.fn(async()=>({statusCode:200,body:{id,object:"transfer",status:"needs_review"}}));
  const client=new OzavClient({mode: "test", apiKey:"ozav_sk_test_example",writeTransport:write});
  expect(await client.createCustomerPixTransfer(input)).toEqual({id,transfer:null,facility:null});
  expect(write).toHaveBeenCalledTimes(1);expect(write.mock.calls[0]![0]).toMatchObject({idempotencyKey:input.idempotencyKey,body:{customer_id:customer,destination:{wallet_id:wallet,chain:"solana"}}});
 });
 it.each([202,400,409,422,500])("does not retry creation on HTTP %i",async statusCode=>{
  const write=vi.fn(async()=>({statusCode,body:{}})),client=new OzavClient({mode: "test", apiKey:"ozav_sk_test_example",attempts:3,writeTransport:write});
  await expect(client.createCustomerPixTransfer(input)).rejects.toThrow();expect(write).toHaveBeenCalledTimes(1);
 });
 it("does not retry a dropped connection",async()=>{
  const write=vi.fn(async()=>{throw new Error("lost response");}),client=new OzavClient({mode: "test", apiKey:"ozav_sk_test_example",writeTransport:write});
  await expect(client.createCustomerPixTransfer(input)).rejects.toThrow();expect(write).toHaveBeenCalledTimes(1);
 });
 it("requires one active managed wallet, rejecting foreign or ambiguous wallet results",async()=>{
  for(const data of [[{id:wallet,customer_id:customer,custody_model:"managed",status:"active"},{id:"ozav_wal_second",customer_id:customer,custody_model:"managed",status:"active"}],[{id:wallet,customer_id:"ozav_cus_foreign",custody_model:"managed",status:"active"}],[]]){
   const c=new OzavClient({mode: "test", apiKey:"ozav_sk_test_example",transport:async()=>({statusCode:200,body:{data,has_more:false}})});
   await expect(c.getCustomerManagedWallet(customer)).rejects.toThrow();
  }
 });
 it("recovers by customer and metadata through all pages, without calling POST",async()=>{
  const read=vi.fn(async(path:string)=>({statusCode:200,body:path.includes("starting_after")?{data:[{id,customer_id:customer,metadata:{peragus_pix_id:"local"}}],has_more:false}:{data:[],has_more:true,next_cursor:"cursor"}}));
  const write=vi.fn(),c=new OzavClient({mode: "test", apiKey:"ozav_sk_test_example",transport:read,writeTransport:write});
  expect(await c.findCustomerPixTransfer(customer,"local")).toBe(id);expect(read).toHaveBeenCalledTimes(2);expect(write).not.toHaveBeenCalled();
 });
 it.each([409,500])("never retries simulation after HTTP %i",async statusCode=>{
  const write=vi.fn(async()=>({statusCode,body:{}})),client=new OzavClient({mode: "test", apiKey:"ozav_sk_test_example",attempts:3,writeTransport:write});
  await expect(client.simulateCustomerPixPayment(id)).rejects.toThrow();expect(write).toHaveBeenCalledTimes(1);
 });
 it("does not trust simulation response body as payment evidence",async()=>{
  const write=vi.fn(async()=>({statusCode:200,body:{status:"completed",untrusted:true}})),client=new OzavClient({mode: "test", apiKey:"ozav_sk_test_example",writeTransport:write});
  await expect(client.simulateCustomerPixPayment(id)).resolves.toBeUndefined();expect(write.mock.calls[0]![0]).toMatchObject({path:`/v2/transfers/${id}/simulate`,body:{}});
 });
 it("rejects live keys before any request",()=>{expect(()=>new OzavClient({mode: "test", apiKey:"ozav_sk_live_example"})).toThrow();});
});

describe("live customer Pix with the FX rate lock",()=>{
 const created=(facility?:unknown)=>({id,object:"transfer",status:"awaiting_payment",customer_id:customer,quote_id:"ozav_q_testquote",
  source:{type:"fiat_payment",currency:"BRL",rail:"pix",payment_instructions:{rail:"pix",intent_id:"8d7c",br_code:"000201live",qr_code_image:null,expires_at:"2099-01-01T00:00:00Z"}},
  destination:{type:"wallet",wallet_id:wallet},amounts:{source:{currency:"BRL",amount:"1000.00"},target:{currency:"USDT",amount:"200.000000"}},
  ...(facility===undefined?{}:{facility})});
 const locked={locked:true,state:"locked",amount:"200.000000",currency:"USDT",deadline_at:"2099-01-01T00:00:00Z",counterparty_amount:"201.0"};
 const liveClient=(write:any)=>new OzavClient({mode:"live",apiKey:"ozav_sk_live_example",attempts:3,writeTransport:write});
 it("live transfer carries facility_terms_accepted and version and the Idempotency-Key peragus-pix-<uuid>",async()=>{
  const write=vi.fn(async()=>({statusCode:201,body:created(locked)}));
  const r=await liveClient(write).createCustomerPixTransfer({...input,facilityTermsVersion:"2.0"});
  expect(write).toHaveBeenCalledTimes(1);
  const request=write.mock.calls[0]![0] as any;
  expect(request.idempotencyKey).toBe(input.idempotencyKey);expect(request.idempotencyKey).toMatch(/^peragus-pix-[0-9a-f-]{36}$/);
  expect(request.body).toMatchObject({facility_terms_accepted:true,facility_terms_version:"2.0",destination:{type:"wallet",wallet_id:wallet,chain:"solana"}});
  expect(request.body.facility_terms_accepted).toBe(true);
  expect(r.facility).toEqual({locked:true,state:"locked",reason:null,amount:"200.000000",currency:"USDT",deadlineAt:"2099-01-01T00:00:00Z"});
  expect(r.transfer?.source.paymentInstructions?.brCode).toBe("000201live");
 });
 it("live refuses a missing or malformed terms version and test refuses any, before any request",async()=>{
  for(const facilityTermsVersion of [undefined,""," 2.0","x".repeat(65)]){
   const write=vi.fn();await expect(liveClient(write).createCustomerPixTransfer({...input,...(facilityTermsVersion===undefined?{}:{facilityTermsVersion})})).rejects.toThrow();expect(write).not.toHaveBeenCalled();
  }
  const write=vi.fn(),test=new OzavClient({mode:"test",apiKey:"ozav_sk_test_example",writeTransport:write});
  await expect(test.createCustomerPixTransfer({...input,facilityTermsVersion:"2.0"})).rejects.toThrow();expect(write).not.toHaveBeenCalled();
 });
 it.each([["FACILITY_LOCK_UNAVAILABLE","client_not_exempt"],["FACILITY_LOCK_UNAVAILABLE","terms_version_mismatch"],["FACILITY_TERMS_VERSION_REQUIRED",undefined]])
 ("maps 422 %s (%s) to an unambiguous lock refusal without retrying",async(code,reason)=>{
  const write=vi.fn(async()=>({statusCode:422,body:{error:{code,message:"never surfaced",...(reason?{details:{reason}}:{})}}}));
  const error=await liveClient(write).createCustomerPixTransfer({...input,facilityTermsVersion:"2.0"}).catch(e=>e);
  expect(error).toBeInstanceOf(OzavFacilityLockRefusedError);
  expect(error).toMatchObject({ozavErrorCode:code,reason:reason??null,statusCode:422});
  expect(write).toHaveBeenCalledTimes(1);
 });
 it("other 422 codes stay ambiguous (reconciliation), not a lock refusal",async()=>{
  const write=vi.fn(async()=>({statusCode:422,body:{error:{code:"QUOTE_EXPIRED"}}}));
  const error=await liveClient(write).createCustomerPixTransfer({...input,facilityTermsVersion:"2.0"}).catch(e=>e);
  expect(error).not.toBeInstanceOf(OzavFacilityLockRefusedError);
 });
 it("parses not-locked outcomes and treats a malformed or absent facility block as no lock",async()=>{
  for(const [facility,expected] of [
   [{locked:false,state:"refused",reason:"collateral_insufficient",message:"x"},{locked:false,state:"refused",reason:"collateral_insufficient",amount:null,currency:null,deadlineAt:null}],
   [{locked:false,state:"undetermined"},{locked:false,state:"undetermined",reason:null,amount:null,currency:null,deadlineAt:null}],
   [{locked:true,state:"locked"},null],
   // The deadline is passed through as received; the service validates it strictly (LOCK_DEADLINE_INVALID).
   [{locked:true,state:"locked",amount:"1",currency:"USDT"},{locked:true,state:"locked",reason:null,amount:"1",currency:"USDT",deadlineAt:null}],
   [{locked:true,state:"locked",amount:"1",currency:"USDT",deadline_at:"tomorrow"},{locked:true,state:"locked",reason:null,amount:"1",currency:"USDT",deadlineAt:"tomorrow"}],[{locked:"true",state:"locked",amount:"1",currency:"USDT",deadline_at:"2099-01-01T00:00:00Z"},null],
   [{locked:true,state:"not_locked",amount:"1",currency:"USDT",deadline_at:"2099-01-01T00:00:00Z"},null],[undefined,null]] as const){
   const write=vi.fn(async()=>({statusCode:201,body:created(facility)}));
   const r=await liveClient(write).createCustomerPixTransfer({...input,facilityTermsVersion:"2.0"});
   expect(r.id).toBe(id);expect(r.facility).toEqual(expected);
  }
 });
});
