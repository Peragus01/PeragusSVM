import {
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { EnsureSolanaContingencyReserveService } from "../src/application/ensure-solana-contingency-reserve.js";
import { LocalKeypairAuthoritySigner } from "../src/providers/peragus-solana-transaction.js";
import type {
  FinalizeContingencyReserveInput,
  SaveFundedContingencyReserveInput,
  SolanaContingencyReserve,
  SolanaContingencyReserveRepository,
} from "../src/repositories/solana-contingency-reserve-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

class MemoryReserveRepository
  implements SolanaContingencyReserveRepository
{
  value: SolanaContingencyReserve | null = null;

  async find(id: string) {
    return this.value?.settlementId === id
      ? this.value
      : null;
  }

  async saveFunded(input: SaveFundedContingencyReserveInput) {
    const now = new Date("2026-10-07T12:00:01Z");
    this.value ??= {
      ...input,
      settleSignature: null,
      refundSignature: null,
      status: "funded",
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    return this.value;
  }

  async markSettled(
    input: FinalizeContingencyReserveInput,
  ) {
    return this.finalize(input, "settled");
  }

  async markRefunded(
    input: FinalizeContingencyReserveInput,
  ) {
    return this.finalize(input, "refunded");
  }

  private finalize(
    input: FinalizeContingencyReserveInput,
    status: "settled" | "refunded",
  ) {
    if (!this.value || this.value.version !== input.expectedVersion) {
      throw new Error("concurrent reserve update");
    }

    this.value = {
      ...this.value,
      status,
      settleSignature:
        status === "settled" ? input.signature : null,
      refundSignature:
        status === "refunded" ? input.signature : null,
      version: this.value.version + 1,
      updatedAt: new Date("2026-10-07T12:00:02Z"),
    };
    return this.value;
  }
}

function setup() {
  const repository = new MemoryReserveRepository();
  const feePayer = new LocalKeypairAuthoritySigner(
    Keypair.generate(),
  );
  const attestationAuthority =
    new LocalKeypairAuthoritySigner(Keypair.generate());
  const liquidityAuthority =
    new LocalKeypairAuthoritySigner(Keypair.generate());
  const sent: Transaction[] = [];
  const blockhash = Keypair.generate().publicKey.toBase58();

  const connection = {
    async getLatestBlockhash() {
      return {
        blockhash,
        lastValidBlockHeight: 123,
      };
    },
    async getAccountInfo() {
      return null;
    },
    async sendRawTransaction(raw: Buffer | Uint8Array) {
      sent.push(Transaction.from(Buffer.from(raw)));
      return "reserve-signature";
    },
    async confirmTransaction() {
      return {
        context: { slot: 100 },
        value: { err: null },
      };
    },
  };

  const service = new EnsureSolanaContingencyReserveService({
    repository,
    connection,
    programId: new PublicKey(
      "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w",
    ),
    destinationMint: Keypair.generate().publicKey,
    feePayer,
    attestationAuthority,
    liquidityAuthority,
    fallbackDelaySeconds: 300,
    now: () => new Date("2026-10-07T12:00:00Z"),
  });

  return {
    repository,
    sent,
    feePayer,
    attestationAuthority,
    liquidityAuthority,
    service,
  };
}

const input = {
  settlementId,
  corridorId: "ab".repeat(32),
  recipientWallet:
    "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
  amountUsdt: "89.550000",
  expiresAt: new Date("2026-10-07T13:00:00Z"),
};

describe("Solana contingency reserve gate", () => {
  it("funds and persists the quoted USDT amount before Pix", async () => {
    const subject = setup();

    const result = await subject.service.ensureBeforePix(input);

    expect(result).toMatchObject({
      settlementId,
      amountUsdt: "89.55",
      amountBaseUnits: "89550000",
      fallbackAfter: new Date("2026-10-07T12:05:00Z"),
      createSignature: "reserve-signature",
      idempotentReplay: false,
    });
    expect(subject.repository.value).toMatchObject({
      reservePda: result.reservePda,
      vaultPda: result.vaultPda,
      status: "funded",
    });
    expect(subject.sent).toHaveLength(1);

    const transaction = subject.sent[0]!;
    expect(transaction.instructions).toHaveLength(1);
    expect(transaction.verifySignatures(true)).toBe(true);
    expect(
      transaction.signatures
        .filter(({ signature }) => signature !== null)
        .map(({ publicKey }) => publicKey.toBase58()),
    ).toEqual(expect.arrayContaining([
      subject.feePayer.publicKey.toBase58(),
      subject.attestationAuthority.publicKey.toBase58(),
      subject.liquidityAuthority.publicKey.toBase58(),
    ]));
  });

  it("replays the stored reserve without another transaction", async () => {
    const subject = setup();
    await subject.service.ensureBeforePix(input);

    const replay = await subject.service.ensureBeforePix({
      ...input,
      amountUsdt: "89.55",
    });

    expect(replay.idempotentReplay).toBe(true);
    expect(subject.sent).toHaveLength(1);
  });

  it("rejects a quote that differs from the funded reserve", async () => {
    const subject = setup();
    await subject.service.ensureBeforePix(input);

    await expect(subject.service.ensureBeforePix({
      ...input,
      amountUsdt: "90",
    })).rejects.toThrow("different contingency reserve");
    expect(subject.sent).toHaveLength(1);
  });

  it("rejects a fallback window beyond settlement expiry", async () => {
    const subject = setup();

    await expect(subject.service.ensureBeforePix({
      ...input,
      expiresAt: new Date("2026-10-07T12:04:59Z"),
    })).rejects.toThrow("expires before");
    expect(subject.sent).toHaveLength(0);
  });
});
