import type {Pool} from "pg";
import {walletProofMessage,WalletProofError,type CustomerWalletRepository,type WalletChallenge,type CustomerWallet} from "../wallets/customer-wallet.js";
interface ChallengeRow {id:string;customer_id:string;wallet_address:string;nonce:string;issued_at:Date|string;expires_at:Date|string;consumed_at:Date|string|null;}
interface WalletRow {wallet_address:string;verified_at:Date|string;}
const time=(v:Date|string)=>new Date(v).toISOString();
const mapWallet=(w:WalletRow):CustomerWallet=>({walletAddress:w.wallet_address,verifiedAt:time(w.verified_at)});
export class PostgresCustomerWalletRepository implements CustomerWalletRepository {
  constructor(private readonly pool:Pool){}
  async find(customerId:string){
    const r=await this.pool.query<WalletRow>("select wallet_address,verified_at from peragus_customer_wallets where customer_id=$1 and environment='test'",[customerId]);
    return r.rows[0]?mapWallet(r.rows[0]):null;
  }
  async challenge(customerId:string){
    const r=await this.pool.query<ChallengeRow>("select * from peragus_customer_wallet_challenges where customer_id=$1 and environment='test'",[customerId]);
    const c=r.rows[0];return c?{id:c.id,customerId:c.customer_id,walletAddress:c.wallet_address,nonce:c.nonce,
      issuedAt:time(c.issued_at),expiresAt:time(c.expires_at),consumedAt:c.consumed_at===null?null:time(c.consumed_at)}:null;
  }
  async issue(c:WalletChallenge){
    // New issue invalidates the prior challenge for this customer. A concurrently
    // confirmed binding cannot be replaced by either this issue or consume().
    await this.pool.query(`insert into peragus_customer_wallet_challenges(customer_id,id,wallet_address,nonce,issued_at,expires_at)
      values($1,$2,$3,$4,$5,$6) on conflict(customer_id) do update set id=excluded.id,wallet_address=excluded.wallet_address,
      nonce=excluded.nonce,issued_at=excluded.issued_at,expires_at=excluded.expires_at,consumed_at=null`,
      [c.customerId,c.id,c.walletAddress,c.nonce,c.issuedAt,c.expiresAt]);
  }
  async consume(c:WalletChallenge,now:Date,signatureBase64:string){
    const client=await this.pool.connect();
    try {
      await client.query("begin");await client.query("set local lock_timeout='1500ms'");
      const claimed=await client.query(`update peragus_customer_wallet_challenges set consumed_at=$4
        where customer_id=$1 and id=$2 and wallet_address=$3 and environment='test'
        and consumed_at is null and expires_at>$4 and issued_at<=$4
        and expires_at>clock_timestamp() returning id`,[c.customerId,c.id,c.walletAddress,now.toISOString()]);
      if(!claimed.rows[0])throw new WalletProofError("WALLET_CHALLENGE_INVALID");
      const saved=await client.query<WalletRow>(`insert into peragus_customer_wallets(customer_id,wallet_address,proof_challenge_id,verified_at,proof_message,proof_signature)
        values($1,$2,$3,$4,$5,$6) on conflict do nothing returning wallet_address,verified_at`,[c.customerId,c.walletAddress,c.id,now.toISOString(),walletProofMessage(c),signatureBase64]);
      if(!saved.rows[0])throw new WalletProofError("WALLET_BINDING_CONFLICT");
      await client.query("commit");return mapWallet(saved.rows[0]);
    } catch(error){await client.query("rollback");throw error;}
    finally{client.release();}
  }
}
