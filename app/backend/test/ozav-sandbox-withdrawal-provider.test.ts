import {randomUUID} from "node:crypto";
import {describe,it,expect,vi} from "vitest";
import {Keypair} from "@solana/web3.js";
import {OzavSandboxWithdrawalProvider} from "../src/providers/ozav-sandbox-withdrawal.js";
const customerId="ozav_cus_testing",walletId="ozav_wal_testing",transferId="ozav_tr_testing",address=Keypair.generate().publicKey.toBase58();
const input={executionId:randomUUID(),withdrawalId:randomUUID(),customerId,walletId,amount:"198.050000",address,verifiedAt:new Date(Date.now()-1000).toISOString(),identity:{name:"Synthetic User",cpf:"11144477735",street:"Synthetic Street, 1",city:"Test",country:"BR" as const}};
const raw=()=>({id:transferId,object:"transfer",customer_id:customerId,status:"completed",source:{type:"wallet",wallet_id:walletId,currency:"USDT",chain:"solana"},destination:{type:"crypto_address",address,network:"solana",currency:"USDT"},amounts:{source:{currency:"USDT",amount:"198.05"},target:{currency:"USDT",amount:"198.05"}},source_leg:{status:"completed"},destination_leg:{status:"completed"},settlement_references:{network:"solana",tx_hash:"synthetic-reference"},travel_rule:{private:"NEVER_PERSIST_THIS"}});
describe("sandbox withdrawal provider contract",()=>{
 it("rejects production keys before any read or send",()=>{expect(()=>new OzavSandboxWithdrawalProvider("ozav_sk_live_example")).toThrow();});
 it("sends explicit Solana with amount, stable idempotency and backend-derived Travel Rule, without a quote",async()=>{
  const write=vi.fn(async()=>({statusCode:201,body:raw()})),p=new OzavSandboxWithdrawalProvider("ozav_sk_test_example",{write});
  expect(await p.send(input)).toBe(transferId);expect(write).toHaveBeenCalledTimes(1);
  const request=write.mock.calls[0]![0] as any;expect(request.idempotencyKey).toBe(`peragus-send-${input.executionId}`);
  expect(request.body).toMatchObject({amount:{currency:"USDT",amount:"198.050000"},source:{wallet_id:walletId,chain:"solana"},destination:{address,network:"solana",currency:"USDT"},travel_rule:{originator:{identity_documents:[{type:"cpf",number:"11144477735",issuing_country:"BR"}]},beneficiary:{wallet_type:"self_custodied",is_self:true,wallet_attested_ownership_at:input.verifiedAt}}});
  expect(request.body.quote_id).toBeUndefined();
 });
 it.each([202,400,409,422,429,500])("never automatically retries a send on HTTP %i",async statusCode=>{
  const write=vi.fn(async()=>({statusCode,body:{}})),p=new OzavSandboxWithdrawalProvider("ozav_sk_test_example",{write});await expect(p.send(input)).rejects.toThrow();expect(write).toHaveBeenCalledTimes(1);
 });
 it("retains a reduced HTTP 200 transfer ID and requires later GET evidence",async()=>{
  const write=vi.fn(async()=>({statusCode:200,body:{id:transferId,object:"transfer",status:"needs_review"}})),p=new OzavSandboxWithdrawalProvider("ozav_sk_test_example",{write});expect(await p.send(input)).toBe(transferId);
 });
 it("strips private Travel Rule and unrelated payload from saved observations",async()=>{
  const p=new OzavSandboxWithdrawalProvider("ozav_sk_test_example",{read:async()=>({statusCode:200,body:raw()})});
  const result=await p.transfer(transferId);expect(result).toMatchObject({customerId,network:"solana",destinationAddress:address,transactionReference:"synthetic-reference"});expect(JSON.stringify(result)).not.toContain("NEVER_PERSIST_THIS");expect(result).not.toHaveProperty("travel_rule");
 });
 it("rejects chain/currency mismatches, including contradictory settlement references",async()=>{
  for(const modify of [(r:any)=>{r.destination.network="tron";},(r:any)=>{r.settlement_references.network="ethereum";},(r:any)=>{r.amounts.target.currency="USDC";}]){
   const r=raw();modify(r);const p=new OzavSandboxWithdrawalProvider("ozav_sk_test_example",{read:async()=>({statusCode:200,body:r})});await expect(p.transfer(transferId)).rejects.toThrow();
  }
 });
 it("extracts only validated BR identity from a ready customer without persisting it",async()=>{
  const c={id:customerId,object:"customer",type:"individual",external_ref:"expected",status:"approved",account_status:"active",verification:{mode:"full"},requirements:{due:[],due_codes:[],missing_fields:[],documents_due:[]},individual:{legal_name:"Synthetic User",tax_id:{type:"cpf",country:"BR",value:"11144477735"},residential_address:{line1:"Synthetic Street",number:"1",city:"Test",country:"BR"}}};
  const p=new OzavSandboxWithdrawalProvider("ozav_sk_test_example",{read:async()=>({statusCode:200,body:c})});expect(await p.identity(customerId,"expected")).toMatchObject({cpf:"11144477735",street:"Synthetic Street, 1"});
  c.account_status="pending";await expect(p.identity(customerId,"expected")).rejects.toThrow();
 });
 it("reads USDT balance without imposing token precision on unrelated native assets",async()=>{
  const p=new OzavSandboxWithdrawalProvider("ozav_sk_test_example",{read:async path=>({statusCode:200,body:path.endsWith("/balances")?{data:[{currency:"SOL",amount:"0.123456789"},{currency:"USDT",amount:"198.05"}]}:{id:walletId,customer_id:customerId,custody_model:"managed",status:"active"}})});
  expect(await p.available(customerId,walletId)).toBe("198.05");
 });
 it("recovers across all pages by customer and execution metadata, never POSTing",async()=>{
  const read=vi.fn(async(path:string)=>({statusCode:200,body:path.includes("starting_after")?{data:[{id:transferId,customer_id:customerId,metadata:{peragus_execution_id:input.executionId}}],has_more:false}:{data:[],has_more:true,next_cursor:"next"}}));
  const write=vi.fn(),p=new OzavSandboxWithdrawalProvider("ozav_sk_test_example",{read,write});expect(await p.find(customerId,input.executionId)).toBe(transferId);expect(read).toHaveBeenCalledTimes(2);expect(write).not.toHaveBeenCalled();
 });
});
