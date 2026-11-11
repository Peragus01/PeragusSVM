import {createPublicKey,randomBytes,randomUUID,verify} from "node:crypto";
import {PublicKey} from "@solana/web3.js";
import type {MoneyEnvironment} from "../config/money-environment.js";
/** The parts of the money environment that bind a wallet proof to one deployment and network. */
export type WalletProofEnvironment=Pick<MoneyEnvironment,"mode"|"network"|"walletProofDomain">;
export interface WalletChallenge {
  id:string;customerId:string;walletAddress:string;nonce:string;issuedAt:string;expiresAt:string;consumedAt:string|null;
}
export interface CustomerWallet {walletAddress:string;verifiedAt:string;}
export interface CustomerWalletRepository {
  find(customerId:string):Promise<CustomerWallet|null>;
  challenge(customerId:string):Promise<WalletChallenge|null>;
  issue(challenge:WalletChallenge):Promise<void>;
  consume(challenge:WalletChallenge,now:Date,signatureBase64:string,proofMessage:string):Promise<CustomerWallet>;
}
export class WalletProofError extends Error {
  constructor(public readonly code:"WALLET_ADDRESS_INVALID"|"WALLET_ALREADY_LINKED"|"WALLET_CHALLENGE_INVALID"|"WALLET_CHALLENGE_EXPIRED"|"WALLET_CHALLENGE_USED"|"WALLET_SIGNATURE_INVALID"|"WALLET_BINDING_CONFLICT") {super(code);}
}
export function canonicalWalletAddress(value:string):string {
  try {
    const key=new PublicKey(value);
    if(key.toBase58()!==value || !PublicKey.isOnCurve(key.toBytes()) || key.toBytes().every(b=>b===0))throw new Error();
    return key.toBase58();
  } catch {throw new WalletProofError("WALLET_ADDRESS_INVALID");}
}
export function walletProofMessage(c:WalletChallenge,e:WalletProofEnvironment):string {
  const account=e.mode==="test"?"Peragus TEST account":"Peragus account";
  return `${e.walletProofDomain} requests proof of control of this Solana wallet:\n${c.walletAddress}\n\nLink this wallet to your authenticated ${account}.\nThis message does not authorize payments or transactions.\n\nURI: https://${e.walletProofDomain}\nVersion: 1\nNetwork: ${e.network}\nAccount ID: ${c.customerId}\nRequest ID: ${c.id}\nNonce: ${c.nonce}\nIssued At: ${c.issuedAt}\nExpiration Time: ${c.expiresAt}`;
}
const view=(w:CustomerWallet|null,e:WalletProofEnvironment)=>w?({wallet_address:w.walletAddress,verified_at:w.verifiedAt,
  proof_type:"signed_message",network:e.network,environment:e.mode,operations_enabled:false}):null;
export class CustomerWalletService {
  constructor(private readonly repository:CustomerWalletRepository,private readonly environment:WalletProofEnvironment,
    private readonly now:()=>Date=()=>new Date()){}
  async read(customerId:string){return view(await this.repository.find(customerId),this.environment);}
  async start(customerId:string,walletAddress:string){
    canonicalWalletAddress(walletAddress);
    if(await this.repository.find(customerId))throw new WalletProofError("WALLET_ALREADY_LINKED");
    const now=this.now();
    const challenge:WalletChallenge={id:randomUUID(),customerId,walletAddress,nonce:randomBytes(32).toString("base64url"),
      issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+300000).toISOString(),consumedAt:null};
    await this.repository.issue(challenge);
    const e=this.environment;
    return {challenge_id:challenge.id,wallet_address:walletAddress,message:walletProofMessage(challenge,e),
      expires_at:challenge.expiresAt,domain:e.walletProofDomain,uri:`https://${e.walletProofDomain}`,
      network:e.network,environment:e.mode,operations_enabled:false};
  }
  async confirm(customerId:string,challengeId:string,signatureBase64:string){
    const c=await this.repository.challenge(customerId),now=this.now();
    if(!c || c.id!==challengeId || c.customerId!==customerId)throw new WalletProofError("WALLET_CHALLENGE_INVALID");
    if(c.consumedAt)throw new WalletProofError("WALLET_CHALLENGE_USED");
    if(Date.parse(c.expiresAt)<=now.getTime() || Date.parse(c.issuedAt)>now.getTime())throw new WalletProofError("WALLET_CHALLENGE_EXPIRED");
    canonicalWalletAddress(c.walletAddress);
    const signature=Buffer.from(signatureBase64,"base64");
    if(signature.length!==64 || signature.toString("base64")!==signatureBase64)throw new WalletProofError("WALLET_SIGNATURE_INVALID");
    const publicKey=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),new PublicKey(c.walletAddress).toBuffer()]),format:"der",type:"spki"});
    const message=walletProofMessage(c,this.environment);
    if(!verify(null,Buffer.from(message,"utf8"),publicKey,signature))throw new WalletProofError("WALLET_SIGNATURE_INVALID");
    return view(await this.repository.consume(c,now,signatureBase64,message),this.environment);
  }
}
