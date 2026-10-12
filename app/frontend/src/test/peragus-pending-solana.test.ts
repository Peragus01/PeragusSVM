// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { PreparedSettlement } from "@/lib/peragus/api";
import {
  clearPendingSolanaTransaction,
  createPendingSolanaTransaction,
  loadPendingSolanaTransaction,
  savePendingSolanaTransaction,
} from "@/lib/peragus/pending-solana-transaction";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function signedFixture() {
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 1,
    }),
  );
  transaction.sign(payer);
  const prepared: PreparedSettlement = {
    settlement_id: "11111111-1111-4111-8111-111111111111",
    settlement_pda: recipient.publicKey.toBase58(),
    corridor_pda: recipient.publicKey.toBase58(),
    config_pda: recipient.publicKey.toBase58(),
    transaction_base64: "unused",
    message_hash: "a".repeat(64),
    fee_payer: payer.publicKey.toBase58(),
    required_external_signer: payer.publicKey.toBase58(),
    recent_blockhash: blockhash,
    last_valid_block_height: 123,
  };
  return { payer, prepared, transaction };
}

describe("pending Solana transaction recovery", () => {
  it("stores the exact signed bytes and derives the payer signature before broadcast", () => {
    const storage = new MemoryStorage();
    const { prepared, transaction } = signedFixture();
    const pending = createPendingSolanaTransaction(prepared.settlement_id, prepared, transaction);
    expect(pending.signature).toBe(bs58.encode(transaction.signature!));
    savePendingSolanaTransaction(pending, storage);
    expect(loadPendingSolanaTransaction(prepared.settlement_id, storage)).toEqual(pending);
    expect(
      Transaction.from(Buffer.from(pending.signedTransactionBase64, "base64")).signature,
    ).toEqual(transaction.signature);
  });

  it("removes invalid recovery data and clears completed entries", () => {
    const storage = new MemoryStorage();
    const settlementId = "11111111-1111-4111-8111-111111111111";
    storage.setItem(`peragus:pending-solana:v1:${settlementId}`, "{bad json");
    expect(loadPendingSolanaTransaction(settlementId, storage)).toBeNull();
    expect(storage.length).toBe(0);

    const { prepared, transaction } = signedFixture();
    savePendingSolanaTransaction(
      createPendingSolanaTransaction(settlementId, prepared, transaction),
      storage,
    );
    clearPendingSolanaTransaction(settlementId, storage);
    expect(loadPendingSolanaTransaction(settlementId, storage)).toBeNull();
  });
});
