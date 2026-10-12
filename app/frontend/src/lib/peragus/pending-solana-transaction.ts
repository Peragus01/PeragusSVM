import bs58 from "bs58";
import { Transaction } from "@solana/web3.js";
import type { PreparedSettlement } from "./api";

const STORAGE_PREFIX = "peragus:pending-solana:v1:";

export interface PendingSolanaTransaction {
  version: 1;
  settlementId: string;
  signature: string;
  signedTransactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  messageHash: string;
  savedAt: string;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function isPending(value: unknown, settlementId: string): value is PendingSolanaTransaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item["version"] === 1 &&
    item["settlementId"] === settlementId &&
    typeof item["signature"] === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(item["signature"]) &&
    typeof item["signedTransactionBase64"] === "string" &&
    item["signedTransactionBase64"].length > 0 &&
    typeof item["recentBlockhash"] === "string" &&
    item["recentBlockhash"].length > 0 &&
    typeof item["lastValidBlockHeight"] === "number" &&
    Number.isSafeInteger(item["lastValidBlockHeight"]) &&
    item["lastValidBlockHeight"] > 0 &&
    typeof item["messageHash"] === "string" &&
    /^[0-9a-f]{64}$/i.test(item["messageHash"]) &&
    typeof item["savedAt"] === "string" &&
    !Number.isNaN(Date.parse(item["savedAt"]))
  );
}

export function createPendingSolanaTransaction(
  settlementId: string,
  prepared: PreparedSettlement,
  signed: Transaction,
): PendingSolanaTransaction {
  const payerSlot = signed.signatures.find(
    (slot) => slot.publicKey.toBase58() === prepared.fee_payer,
  );
  if (!payerSlot?.signature) {
    throw new Error("The signed transaction has no payer signature to recover.");
  }
  return {
    version: 1,
    settlementId,
    signature: bs58.encode(payerSlot.signature),
    signedTransactionBase64: bytesToBase64(signed.serialize()),
    recentBlockhash: prepared.recent_blockhash,
    lastValidBlockHeight: prepared.last_valid_block_height,
    messageHash: prepared.message_hash.toLowerCase(),
    savedAt: new Date().toISOString(),
  };
}

export function savePendingSolanaTransaction(
  pending: PendingSolanaTransaction,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage) throw new Error("Browser storage is unavailable; the transaction was not sent.");
  storage.setItem(`${STORAGE_PREFIX}${pending.settlementId}`, JSON.stringify(pending));
}

export function loadPendingSolanaTransaction(
  settlementId: string,
  storage: Storage | null = browserStorage(),
): PendingSolanaTransaction | null {
  if (!storage) return null;
  const key = `${STORAGE_PREFIX}${settlementId}`;
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPending(parsed, settlementId)) return parsed;
  } catch {
    // Invalid recovery data is removed below.
  }
  storage.removeItem(key);
  return null;
}

export function clearPendingSolanaTransaction(
  settlementId: string,
  storage: Storage | null = browserStorage(),
): void {
  storage?.removeItem(`${STORAGE_PREFIX}${settlementId}`);
}
