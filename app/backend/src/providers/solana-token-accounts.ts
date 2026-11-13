import {PublicKey,type Connection} from "@solana/web3.js";

/** Classic SPL Token program (the Mainnet USDT mint is a classic SPL token). */
export const SPL_TOKEN_PROGRAM_ID=new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID=new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/**
 * Read-only destination check used before a USDT send. Implementations never sign or send;
 * tests inject fakes, production uses createSolanaTokenAccountReader over the configured RPC.
 */
/** ready: initialized and able to receive; frozen: exists but frozen by the mint's freeze authority; missing: anything else. */
export type TokenAccountState="ready"|"missing"|"frozen";
export interface DestinationTokenAccountReader {
 /** State of `owner`'s associated token account for `mint`. Throws when it cannot tell. */
 tokenAccountState(owner:string,mint:string):Promise<TokenAccountState>;
}

export function associatedTokenAddress(owner:string,mint:string):PublicKey {
 return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),SPL_TOKEN_PROGRAM_ID.toBuffer(),new PublicKey(mint).toBuffer()],ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Derives the owner's associated token account for the mint and reads it (getParsedAccountInfo). */
export function createSolanaTokenAccountReader(connection:Pick<Connection,"getParsedAccountInfo">):DestinationTokenAccountReader {
 return Object.freeze({
  async tokenAccountState(owner:string,mint:string):Promise<TokenAccountState>{
   const address=associatedTokenAddress(owner,mint);
   const result=await connection.getParsedAccountInfo(address,"confirmed");
   const account=result.value;
   if(!account)return "missing";
   if(!account.owner.equals(SPL_TOKEN_PROGRAM_ID))return "missing";
   const data=account.data;
   if(Buffer.isBuffer(data) || typeof data!=="object" || data===null || !("parsed" in data))throw new Error("TOKEN_ACCOUNT_UNPARSED");
   const parsed=data.parsed as {type?:unknown;info?:{mint?:unknown;owner?:unknown;state?:unknown}}|null;
   if(parsed?.type!=="account" || parsed.info?.mint!==mint || parsed.info?.owner!==owner)return "missing";
   return parsed.info?.state==="initialized"?"ready":parsed.info?.state==="frozen"?"frozen":"missing";
  }
 });
}
