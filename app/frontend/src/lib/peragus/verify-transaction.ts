import { Transaction } from "@solana/web3.js";
import type { PreparedSettlement } from "./api";

export type VerificationCode =
  | "SIGNER_MISMATCH"
  | "FEE_PAYER_MISMATCH"
  | "BLOCKHASH_MISMATCH"
  | "PAYER_SLOT_MISSING"
  | "PAYER_ALREADY_SIGNED"
  | "COSIGNATURE_INVALID"
  | "MESSAGE_HASH_MISMATCH"
  | "MESSAGE_ALTERED"
  | "SIGNATURES_INCOMPLETE";

export class TransactionVerificationError extends Error {
  readonly code: VerificationCode;
  constructor(code: VerificationCode, message: string) {
    super(message);
    this.name = "TransactionVerificationError";
    this.code = code;
  }
}

const fail = (code: VerificationCode, message: string): never => {
  throw new TransactionVerificationError(code, message);
};

export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Runs every pre-signing check from the integration contract. Never rebuilds the transaction. */
export async function verifyPreparedTransaction(
  prepared: PreparedSettlement,
  connectedSigner: string,
): Promise<Transaction> {
  const tx = Transaction.from(base64ToBytes(prepared.transaction_base64));
  if (connectedSigner !== prepared.required_external_signer)
    fail("SIGNER_MISMATCH", "The connected wallet is not the payer this settlement requires.");
  if (prepared.fee_payer !== connectedSigner || tx.feePayer?.toBase58() !== connectedSigner)
    fail("FEE_PAYER_MISMATCH", "The transaction fee payer does not match the required signer.");
  if (tx.recentBlockhash !== prepared.recent_blockhash)
    fail("BLOCKHASH_MISMATCH", "The transaction blockhash does not match the prepared metadata.");
  const slot = tx.signatures.find((s) => s.publicKey.toBase58() === connectedSigner);
  if (!slot) fail("PAYER_SLOT_MISSING", "The transaction has no signature slot for the payer.");
  if (slot?.signature && slot.signature.some((b) => b !== 0))
    fail("PAYER_ALREADY_SIGNED", "The payer signature slot is unexpectedly filled.");
  if (!tx.verifySignatures(false))
    fail("COSIGNATURE_INVALID", "A Peragus co-signature on this transaction is invalid.");
  const hash = await sha256Hex(tx.serializeMessage());
  if (hash !== prepared.message_hash.toLowerCase())
    fail("MESSAGE_HASH_MISMATCH", "The transaction message hash does not match the backend.");
  return tx;
}

/** Confirms the wallet only added signatures and that every required signature is valid. */
export function verifySignedTransaction(signedBytes: Uint8Array, original: Transaction) {
  const signed = Transaction.from(signedBytes);
  if (!sameBytes(signed.serializeMessage(), original.serializeMessage()))
    fail("MESSAGE_ALTERED", "The wallet altered the transaction. It was not broadcast.");
  if (!signed.verifySignatures(true))
    fail("SIGNATURES_INCOMPLETE", "The signed transaction is missing a valid signature.");
  return signed;
}
