import {describe,expect,it,vi} from "vitest";
import {Keypair} from "@solana/web3.js";
import {verifyUsdtDelivery,isSolanaSignature} from "../src/solana/usdt-delivery-verifier.js";
import {MAINNET_USDT_MINT} from "../src/config/money-environment.js";

const mint=MAINNET_USDT_MINT,owner=Keypair.generate().publicKey.toBase58(),custody=Keypair.generate().publicKey.toBase58();
// A syntactically valid signature (64 bytes in base58); never looked up on a real RPC.
const txHash="5".repeat(88);
const balance=(accountIndex:number,who:string,amount:string,token=mint)=>({accountIndex,mint:token,owner:who,uiTokenAmount:{amount,decimals:6,uiAmount:null,uiAmountString:""}});
/** Parsed transaction fixture: custody pays `sent`, `to` receives `credited` of `token`. */
const parsed=(o:{credited?:string;to?:string;token?:string;err?:unknown;pre?:string}={})=>{
 const credited=BigInt(o.credited??"199500000"),pre=BigInt(o.pre??"1000000"),token=o.token??mint,to=o.to??owner;
 return{slot:1,blockTime:1,transaction:{},meta:{err:o.err??null,fee:5000,
  preTokenBalances:[balance(1,custody,"900000000",token),balance(2,to,pre.toString(),token)],
  postTokenBalances:[balance(1,custody,(900000000n-credited).toString(),token),balance(2,to,(pre+credited).toString(),token)]}} as any;
};
const connection=(tx:unknown)=>({getParsedTransaction:vi.fn(async()=>tx)}) as any;
const input=(c:any,expected=199500000n,tolerance=0n)=>({connection:c,txHash,mint,ownerWallet:owner,expectedUnits:expected,toleranceUnits:tolerance});

describe("USDT delivery verifier (no real RPC)",()=>{
 it("verifies exact delivery",async()=>{
  const c=connection(parsed());
  expect(await verifyUsdtDelivery(input(c))).toEqual({verified:true,deliveredUnits:199500000n});
  expect(c.getParsedTransaction).toHaveBeenCalledWith(txHash,{commitment:"finalized",maxSupportedTransactionVersion:0});
 });
 it("counts a credit to a token account that did not exist before the transaction",async()=>{
  const tx=parsed();tx.meta.preTokenBalances=tx.meta.preTokenBalances.filter((b:any)=>b.owner!==owner);
  tx.meta.postTokenBalances[1].uiTokenAmount.amount="199500000";
  expect(await verifyUsdtDelivery(input(connection(tx)))).toEqual({verified:true,deliveredUnits:199500000n});
 });
 it("null transaction → NOT_FINALIZED",async()=>{
  expect(await verifyUsdtDelivery(input(connection(null)))).toEqual({verified:false,reason:"NOT_FINALIZED"});
  expect(await verifyUsdtDelivery(input(connection({slot:1,transaction:{},meta:null})))).toEqual({verified:false,reason:"NOT_FINALIZED"});
 });
 it("a hash that is not a Solana signature is NOT_FINALIZED without an RPC call",async()=>{
  const c=connection(parsed());
  expect(await verifyUsdtDelivery({...input(c),txHash:"synthetic-sandbox-reference"})).toEqual({verified:false,reason:"NOT_FINALIZED"});
  expect(c.getParsedTransaction).not.toHaveBeenCalled();
  expect(isSolanaSignature(txHash)).toBe(true);expect(isSolanaSignature(owner)).toBe(false);expect(isSolanaSignature("0OIl")).toBe(false);
 });
 it("meta.err → TX_FAILED",async()=>{
  expect(await verifyUsdtDelivery(input(connection(parsed({err:{InstructionError:[0,"Custom"]}}))))).toEqual({verified:false,reason:"TX_FAILED"});
 });
 it("other mint → MINT_MISMATCH",async()=>{
  const other=Keypair.generate().publicKey.toBase58();
  expect(await verifyUsdtDelivery(input(connection(parsed({token:other}))))).toEqual({verified:false,reason:"MINT_MISMATCH"});
  // No token movement at all is not a delivery of this mint either.
  const empty=parsed();empty.meta.preTokenBalances=[];empty.meta.postTokenBalances=[];
  expect(await verifyUsdtDelivery(input(connection(empty)))).toEqual({verified:false,reason:"MINT_MISMATCH"});
 });
 it("credit to another owner → RECIPIENT_MISMATCH",async()=>{
  const stranger=Keypair.generate().publicKey.toBase58();
  expect(await verifyUsdtDelivery(input(connection(parsed({to:stranger}))))).toEqual({verified:false,reason:"RECIPIENT_MISMATCH"});
 });
 it("credit below expected minus tolerance → AMOUNT_MISMATCH",async()=>{
  // Review Focus 5: one unit below the floor is never verified.
  expect(await verifyUsdtDelivery(input(connection(parsed({credited:"199499999"}))))).toEqual({verified:false,reason:"AMOUNT_MISMATCH"});
  expect(await verifyUsdtDelivery(input(connection(parsed({credited:"199899999"})),200000000n,100000n))).toEqual({verified:false,reason:"AMOUNT_MISMATCH"});
  expect(await verifyUsdtDelivery(input(connection(parsed({credited:"199900000"})),200000000n,100000n))).toEqual({verified:true,deliveredUnits:199900000n});
 });
 it("a credit above the expected amount is a mismatch, not a verified delivery",async()=>{
  expect(await verifyUsdtDelivery(input(connection(parsed({credited:"199500001"}))))).toEqual({verified:false,reason:"AMOUNT_MISMATCH"});
 });
 it("propagates an RPC failure instead of guessing, and rejects unreadable balances",async()=>{
  await expect(verifyUsdtDelivery(input({getParsedTransaction:async()=>{throw new Error("rpc down");}} as any))).rejects.toThrow("rpc down");
  const broken=parsed();broken.meta.postTokenBalances[1].uiTokenAmount.amount="1.5";
  await expect(verifyUsdtDelivery(input(connection(broken)))).rejects.toThrow("TOKEN_BALANCE_UNREADABLE");
  await expect(verifyUsdtDelivery(input(connection(parsed()),-1n))).rejects.toThrow("DELIVERY_EXPECTATION_INVALID");
 });
});
