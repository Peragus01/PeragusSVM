import type {Connection} from "@solana/web3.js";

export type DeliveryMismatch="NOT_FINALIZED"|"BLOCK_TIME_MISSING"|"TX_FAILED"|"TX_PREDATES_SEND"|"MINT_MISMATCH"|"RECIPIENT_MISMATCH"|"AMOUNT_MISMATCH";
export type DeliveryVerification={verified:true;deliveredUnits:bigint}|{verified:false;reason:DeliveryMismatch};
export interface DeliveryVerificationInput {
 /** Read-only RPC; tests inject a fake, production passes the configured Connection. */
 connection:Pick<Connection,"getParsedTransaction">;
 txHash:string;
 mint:string;
 /** The customer's wallet (owner of the credited token account), not the token account address. */
 ownerWallet:string;
 /** Units (6 decimals) the wallet must have been credited. */
 expectedUnits:bigint;
 /** Units the credit may fall short of `expectedUnits` (0 = exact). */
 toleranceUnits:bigint;
 /**
  * Unix seconds the transaction's block time must not precede (the send attempt minus a clock
  * allowance). A transaction without a block time cannot prove it yet: BLOCK_TIME_MISSING (the
  * caller keeps the delivery pending and retries; an RPC without blockTime is a config issue).
  */
 notBeforeUnix?:number;
}

const BASE58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** True for a base58 string that decodes to exactly 64 bytes (a Solana transaction signature). */
export function isSolanaSignature(value:unknown):value is string {
 if(typeof value!=="string" || value.length<64 || value.length>88)return false;
 let n=0n,zeros=0,leading=true;
 for(const ch of value){
  const digit=BASE58.indexOf(ch);if(digit<0)return false;
  if(leading && digit===0)zeros++;else leading=false;
  n=n*58n+BigInt(digit);
 }
 let bytes=0;for(let rest=n;rest>0n;rest>>=8n)bytes++;
 return zeros+bytes===64;
}

interface TokenBalance {accountIndex:number;mint:string;owner?:string|undefined;uiTokenAmount:{amount:string}}
const units=(b:TokenBalance)=>{
 const amount=b?.uiTokenAmount?.amount;
 if(typeof amount!=="string" || !/^\d{1,20}$/.test(amount) || !Number.isInteger(b.accountIndex) || typeof b.mint!=="string")throw new Error("TOKEN_BALANCE_UNREADABLE");
 return BigInt(amount);
};

/**
 * Independent check of a USDT delivery on chain. Reads one finalized transaction and compares
 * what the customer's wallet was credited (`post − pre` of the token balances whose owner is
 * the wallet and whose mint is the expected one) with the expected amount.
 *
 * Verified only when `expectedUnits − toleranceUnits <= credited <= expectedUnits`. Never signs
 * or sends. Throws when the RPC cannot answer or the answer is unreadable (the caller retries);
 * a hash that is not a Solana signature cannot be on chain and answers NOT_FINALIZED.
 */
export async function verifyUsdtDelivery(input:DeliveryVerificationInput):Promise<DeliveryVerification>{
 const {expectedUnits,toleranceUnits}=input;
 if(typeof expectedUnits!=="bigint" || typeof toleranceUnits!=="bigint" || expectedUnits<=0n || toleranceUnits<0n || toleranceUnits>=expectedUnits)
  throw new Error("DELIVERY_EXPECTATION_INVALID");
 if(!isSolanaSignature(input.txHash))return{verified:false,reason:"NOT_FINALIZED"};
 const tx=await input.connection.getParsedTransaction(input.txHash,{commitment:"finalized",maxSupportedTransactionVersion:0});
 if(!tx || !tx.meta)return{verified:false,reason:"NOT_FINALIZED"};
 if(tx.meta.err!==null && tx.meta.err!==undefined)return{verified:false,reason:"TX_FAILED"};
 if(input.notBeforeUnix!==undefined && typeof tx.blockTime!=="number")return{verified:false,reason:"BLOCK_TIME_MISSING"};
 if(input.notBeforeUnix!==undefined && tx.blockTime!<input.notBeforeUnix)return{verified:false,reason:"TX_PREDATES_SEND"};
 // Net change per token account (a missing pre balance is an account created by this transaction).
 const changes=new Map<number,{mint:string;owner:string|undefined;delta:bigint}>();
 for(const post of (tx.meta.postTokenBalances??[]) as TokenBalance[])changes.set(post.accountIndex,{mint:post.mint,owner:post.owner,delta:units(post)});
 for(const pre of (tx.meta.preTokenBalances??[]) as TokenBalance[]){
  const entry=changes.get(pre.accountIndex);
  if(entry)entry.delta-=units(pre);else changes.set(pre.accountIndex,{mint:pre.mint,owner:pre.owner,delta:-units(pre)});
 }
 let credited=0n,creditedElsewhere=false;
 for(const change of changes.values()){
  if(change.mint!==input.mint)continue;
  if(change.owner===input.ownerWallet)credited+=change.delta;
  else if(change.delta>0n)creditedElsewhere=true;
 }
 if(credited<=0n)return{verified:false,reason:creditedElsewhere?"RECIPIENT_MISMATCH":"MINT_MISMATCH"};
 if(credited<expectedUnits-toleranceUnits || credited>expectedUnits)return{verified:false,reason:"AMOUNT_MISMATCH"};
 return{verified:true,deliveredUnits:credited};
}
