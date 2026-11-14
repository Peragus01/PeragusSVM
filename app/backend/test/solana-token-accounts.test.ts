import {describe,expect,it,vi} from "vitest";
import {Keypair,PublicKey} from "@solana/web3.js";
import {ASSOCIATED_TOKEN_PROGRAM_ID,SPL_TOKEN_PROGRAM_ID,associatedTokenAddress,createSolanaTokenAccountReader} from "../src/providers/solana-token-accounts.js";
import {MAINNET_USDT_MINT} from "../src/config/money-environment.js";

const owner=Keypair.generate().publicKey.toBase58(),mint=MAINNET_USDT_MINT;
const account=(info:Record<string,unknown>,programOwner=SPL_TOKEN_PROGRAM_ID)=>({value:{owner:programOwner,lamports:1,executable:false,
 data:{program:"spl-token",space:165,parsed:{type:"account",info:{mint,owner,state:"initialized",tokenAmount:{amount:"0",decimals:6}}}}} as any});
describe("destination token account reader (no real RPC)",()=>{
 it("derives the classic associated token account address",()=>{
  const expected=PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),SPL_TOKEN_PROGRAM_ID.toBuffer(),new PublicKey(mint).toBuffer()],ASSOCIATED_TOKEN_PROGRAM_ID)[0];
  expect(associatedTokenAddress(owner,mint).equals(expected)).toBe(true);
 });
 it("finds an initialized account for the mint and owner at the derived address",async()=>{
  const getParsedAccountInfo=vi.fn(async()=>account({}));
  expect(await createSolanaTokenAccountReader({getParsedAccountInfo}).tokenAccountState(owner,mint)).toBe("ready");
  expect((getParsedAccountInfo.mock.calls[0] as unknown[])[0]).toEqual(associatedTokenAddress(owner,mint));
 });
 it("reports a missing or foreign account as missing and a frozen one as frozen",async()=>{
  const missing=createSolanaTokenAccountReader({getParsedAccountInfo:async()=>({value:null}) as any});
  expect(await missing.tokenAccountState(owner,mint)).toBe("missing");
  const otherProgram=createSolanaTokenAccountReader({getParsedAccountInfo:async()=>account({},Keypair.generate().publicKey)});
  expect(await otherProgram.tokenAccountState(owner,mint)).toBe("missing");
  const frozen=createSolanaTokenAccountReader({getParsedAccountInfo:async()=>{const a=account({});a.value.data.parsed.info.state="frozen";return a;}});
  expect(await frozen.tokenAccountState(owner,mint)).toBe("frozen");
  const otherMint=createSolanaTokenAccountReader({getParsedAccountInfo:async()=>{const a=account({});a.value.data.parsed.info.mint=Keypair.generate().publicKey.toBase58();return a;}});
  expect(await otherMint.tokenAccountState(owner,mint)).toBe("missing");
 });
 it("fails instead of guessing when the RPC answer is unparsed or unavailable",async()=>{
  const raw=createSolanaTokenAccountReader({getParsedAccountInfo:async()=>({value:{owner:SPL_TOKEN_PROGRAM_ID,lamports:1,executable:false,data:Buffer.alloc(165)}}) as any});
  await expect(raw.tokenAccountState(owner,mint)).rejects.toThrow();
  const down=createSolanaTokenAccountReader({getParsedAccountInfo:async()=>{throw new Error("rpc down");}});
  await expect(down.tokenAccountState(owner,mint)).rejects.toThrow();
 });
});
