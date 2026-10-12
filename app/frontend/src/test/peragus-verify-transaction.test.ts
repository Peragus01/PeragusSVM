// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import type { PreparedSettlement } from "@/lib/peragus/api";
import {
  TransactionVerificationError,
  verifyPreparedTransaction,
  verifySignedTransaction,
} from "@/lib/peragus/verify-transaction";

async function prepared() {
  const payer = Keypair.generate();
  const cosigner = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({
      fromPubkey: cosigner.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1,
    }),
  );
  tx.partialSign(cosigner);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(tx.serializeMessage()));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const bytes = tx.serialize({ requireAllSignatures: false });
  const data: PreparedSettlement = {
    settlement_id: "s",
    settlement_pda: "p",
    corridor_pda: "c",
    config_pda: "g",
    transaction_base64: btoa(String.fromCharCode(...bytes)),
    message_hash: hash,
    fee_payer: payer.publicKey.toBase58(),
    required_external_signer: payer.publicKey.toBase58(),
    recent_blockhash: blockhash,
    last_valid_block_height: 1,
  };
  return { payer, data };
}

describe("Prepared transaction verification", () => {
  it("accepts a valid co-signed transaction and a correctly signed result", async () => {
    const { payer, data } = await prepared();
    const tx = await verifyPreparedTransaction(data, payer.publicKey.toBase58());
    tx.partialSign(payer);
    expect(() => verifySignedTransaction(tx.serialize(), tx)).not.toThrow();
  });
  it("rejects a signer mismatch", async () => {
    const { data } = await prepared();
    await expect(
      verifyPreparedTransaction(data, Keypair.generate().publicKey.toBase58()),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
  });
  it("rejects a message hash mismatch", async () => {
    const { payer, data } = await prepared();
    const error = await verifyPreparedTransaction(
      { ...data, message_hash: "0".repeat(64) },
      payer.publicKey.toBase58(),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionVerificationError);
    expect((error as TransactionVerificationError).code).toBe("MESSAGE_HASH_MISMATCH");
  });
  it("rejects a result with the payer signature missing", async () => {
    const { payer, data } = await prepared();
    const tx = await verifyPreparedTransaction(data, payer.publicKey.toBase58());
    expect(() =>
      verifySignedTransaction(tx.serialize({ requireAllSignatures: false }), tx),
    ).toThrow(TransactionVerificationError);
  });
});
