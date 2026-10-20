import {describe,it,expect,vi} from "vitest";
import {OzavClient} from "../src/providers/ozav-client.js";
const customer="ozav_cus_testcustomer",wallet="ozav_wal_testwallet",id="ozav_tr_testtransfer";
const input={customerId:customer,walletId:wallet,quoteId:"ozav_q_testquote",idempotencyKey:"peragus-pix-12345678-1234-4234-8234-123456789abc",metadata:{peragus_pix_id:"local"}};
describe("customer Pix OZAV protocol",()=>{
 it("keeps the reduced 200 transfer ID without attempting to parse a full resource",async()=>{
  const write=vi.fn(async()=>({statusCode:200,body:{id,object:"transfer",status:"needs_review"}}));
  const client=new OzavClient({apiKey:"ozav_sk_test_example",writeTransport:write});
  expect(await client.createCustomerPixTransfer(input)).toEqual({id,transfer:null});
  expect(write).toHaveBeenCalledTimes(1);expect(write.mock.calls[0]![0]).toMatchObject({idempotencyKey:input.idempotencyKey,body:{customer_id:customer,destination:{wallet_id:wallet,chain:"solana"}}});
 });
 it.each([202,400,409,422,500])("does not retry creation on HTTP %i",async statusCode=>{
  const write=vi.fn(async()=>({statusCode,body:{}})),client=new OzavClient({apiKey:"ozav_sk_test_example",attempts:3,writeTransport:write});
  await expect(client.createCustomerPixTransfer(input)).rejects.toThrow();expect(write).toHaveBeenCalledTimes(1);
 });
 it("does not retry a dropped connection",async()=>{
  const write=vi.fn(async()=>{throw new Error("lost response");}),client=new OzavClient({apiKey:"ozav_sk_test_example",writeTransport:write});
  await expect(client.createCustomerPixTransfer(input)).rejects.toThrow();expect(write).toHaveBeenCalledTimes(1);
 });
 it("requires one active managed wallet, rejecting foreign or ambiguous wallet results",async()=>{
  for(const data of [[{id:wallet,customer_id:customer,custody_model:"managed",status:"active"},{id:"ozav_wal_second",customer_id:customer,custody_model:"managed",status:"active"}],[{id:wallet,customer_id:"ozav_cus_foreign",custody_model:"managed",status:"active"}],[]]){
   const c=new OzavClient({apiKey:"ozav_sk_test_example",transport:async()=>({statusCode:200,body:{data,has_more:false}})});
   await expect(c.getCustomerManagedWallet(customer)).rejects.toThrow();
  }
 });
 it("recovers by customer and metadata through all pages, without calling POST",async()=>{
  const read=vi.fn(async(path:string)=>({statusCode:200,body:path.includes("starting_after")?{data:[{id,customer_id:customer,metadata:{peragus_pix_id:"local"}}],has_more:false}:{data:[],has_more:true,next_cursor:"cursor"}}));
  const write=vi.fn(),c=new OzavClient({apiKey:"ozav_sk_test_example",transport:read,writeTransport:write});
  expect(await c.findCustomerPixTransfer(customer,"local")).toBe(id);expect(read).toHaveBeenCalledTimes(2);expect(write).not.toHaveBeenCalled();
 });
 it.each([409,500])("never retries simulation after HTTP %i",async statusCode=>{
  const write=vi.fn(async()=>({statusCode,body:{}})),client=new OzavClient({apiKey:"ozav_sk_test_example",attempts:3,writeTransport:write});
  await expect(client.simulateCustomerPixPayment(id)).rejects.toThrow();expect(write).toHaveBeenCalledTimes(1);
 });
 it("does not trust simulation response body as payment evidence",async()=>{
  const write=vi.fn(async()=>({statusCode:200,body:{status:"completed",untrusted:true}})),client=new OzavClient({apiKey:"ozav_sk_test_example",writeTransport:write});
  await expect(client.simulateCustomerPixPayment(id)).resolves.toBeUndefined();expect(write.mock.calls[0]![0]).toMatchObject({path:`/v2/transfers/${id}/simulate`,body:{}});
 });
 it("rejects live keys before any request",()=>{expect(()=>new OzavClient({apiKey:"ozav_sk_live_example"})).toThrow();});
});
