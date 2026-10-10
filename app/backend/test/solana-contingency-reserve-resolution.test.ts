import { createHash } from "node:crypto";

import {
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { ResolveSolanaContingencyReserveService } from "../src/application/resolve-solana-contingency-reserve.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  LocalKeypairAuthoritySigner,
} from "../src/providers/peragus-solana-transaction.js";
import {
  deriveContingencyReserveAddresses,
} from "../src/providers/peragus-contingency-reserve-transaction.js";
import type {
  FinalizeContingencyReserveInput,
  SaveFundedContingencyReserveInput,
  SolanaContingencyReserve,
  SolanaContingencyReserveRepository,
} from "../src/repositories/solana-contingency-reserve-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";
const corridorId = "ab".repeat(32);
const recipientWallet =
  "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR";
const programId = new PublicKey(
  "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w",
);

class MemoryReserveRepository
  implements SolanaContingencyReserveRepository
{
  settled = 0;
  refunded = 0;

  constructor(public value: SolanaContingencyReserve | null) {}

  async find(id: string) {
    return this.value?.settlementId === id
      ? this.value
      : null;
  }

  async saveFunded(
    _input: SaveFundedContingencyReserveInput,
  ): Promise<SolanaContingencyReserve> {
    throw new Error("not used by resolution tests");
  }

  async markSettled(input: FinalizeContingencyReserveInput) {
    this.settled += 1;
    return this.finalize(input, "settled");
  }

  async markRefunded(input: FinalizeContingencyReserveInput) {
    this.refunded += 1;
    return this.finalize(input, "refunded");
  }

  private finalize(
    input: FinalizeContingencyReserveInput,
    status: "settled" | "refunded",
  ): SolanaContingencyReserve {
    if (
      !this.value
      || this.value.status !== "funded"
      || this.value.version !== input.expectedVersion
    ) {
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
      updatedAt: new Date("2026-10-07T12:10:01Z"),
    };
    return this.value;
  }
}

function discriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`, "utf8")
    .digest()
    .subarray(0, 8);
}

function setup(options: {
  now?: Date;
  status?: "funded" | "settled" | "refunded";
  reserveExists?: boolean;
  stored?: boolean;
} = {}) {
  const destinationMint = Keypair.generate().publicKey;
  const feePayer = new LocalKeypairAuthoritySigner(
    Keypair.generate(),
  );
  const attestationAuthority =
    new LocalKeypairAuthoritySigner(Keypair.generate());
  const liquidityAuthority =
    new LocalKeypairAuthoritySigner(Keypair.generate());
  const derived = deriveContingencyReserveAddresses({
    backendSettlementId: settlementId,
    corridorId,
    destinationMint,
    liquidityAuthority: liquidityAuthority.publicKey,
    programId,
  });
  const status = options.status ?? "funded";
  const stored = options.stored === false
    ? null
    : {
        settlementId,
        reservePda: derived.addresses.reserve.toBase58(),
        vaultPda: derived.addresses.vault.toBase58(),
        amountUsdt: "89.55",
        amountBaseUnits: "89550000",
        fallbackAfter: new Date("2026-10-07T12:05:00Z"),
        expiresAt: new Date("2026-10-07T13:00:00Z"),
        createSignature: "create-signature",
        settleSignature:
          status === "settled" ? "settle-signature" : null,
        refundSignature:
          status === "refunded" ? "refund-signature" : null,
        status,
        version: status === "funded" ? 0 : 1,
        createdAt: new Date("2026-10-07T12:00:00Z"),
        updatedAt: new Date("2026-10-07T12:00:01Z"),
      } satisfies SolanaContingencyReserve;
  const repository = new MemoryReserveRepository(stored);
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
      if (options.reserveExists === false) return null;
      return {
        data: Buffer.alloc(0),
        executable: false,
        lamports: 1,
        owner: programId,
        rentEpoch: 0,
      };
    },
    async sendRawTransaction(raw: Buffer | Uint8Array) {
      sent.push(Transaction.from(Buffer.from(raw)));
      return `resolution-signature-${sent.length}`;
    },
    async confirmTransaction() {
      return {
        context: { slot: 100 },
        value: { err: null },
      };
    },
  };

  const service = new ResolveSolanaContingencyReserveService({
    repository,
    connection,
    programId,
    destinationMint,
    feePayer,
    attestationAuthority,
    liquidityAuthority,
    now: () => options.now
      ?? new Date("2026-10-07T12:10:00Z"),
  });

  return {
    service,
    repository,
    sent,
    feePayer,
    attestationAuthority,
  };
}

function provider(input: Partial<{
  providerStatus: string;
  sourceLegStatus: string | null;
  destinationLegStatus: string | null;
}> = {}) {
  return {
    settlementId,
    corridorId,
    recipientWallet,
    providerStatus: "completed",
    sourceLegStatus: "completed",
    destinationLegStatus: "completed",
    ...input,
  };
}

describe("Solana contingency reserve resolution", () => {
  it("refunds after OZAV completes both legs", async () => {
    const subject = setup();

    const result = await subject.service.execute(provider());

    expect(result).toMatchObject({
      action: "refunded",
      reserveStatus: "refunded",
      reason: "provider_completed",
      signature: "resolution-signature-1",
    });
    expect(subject.repository.refunded).toBe(1);
    expect(subject.repository.settled).toBe(0);
    expect(subject.sent).toHaveLength(1);
    expect(subject.sent[0]!.instructions).toHaveLength(1);
    expect(subject.sent[0]!.instructions[0]!.data).toEqual(
      discriminator("refund_contingency_reserve"),
    );
    expect(subject.sent[0]!.verifySignatures(true)).toBe(true);
  });

  it("refunds a terminal failure before Pix completion", async () => {
    const subject = setup();

    const result = await subject.service.execute(provider({
      providerStatus: "expired",
      sourceLegStatus: "pending",
      destinationLegStatus: "pending",
    }));

    expect(result).toMatchObject({
      action: "refunded",
      reason: "provider_failed_before_payment",
    });
    expect(subject.repository.refunded).toBe(1);
  });

  it("never spends the reserve merely because conversion is slow", async () => {
    const subject = setup({
      now: new Date("2026-10-07T12:30:00Z"),
    });

    const result = await subject.service.execute(provider({
      providerStatus: "converting",
      destinationLegStatus: "pending",
    }));

    expect(result).toMatchObject({
      action: "waiting",
      reason: "provider_pending",
      reserveStatus: "funded",
    });
    expect(subject.sent).toHaveLength(0);
  });

  it("waits for the fallback SLA after a terminal post-Pix failure", async () => {
    const subject = setup({
      now: new Date("2026-10-07T12:04:59Z"),
    });

    const result = await subject.service.execute(provider({
      providerStatus: "failed",
      destinationLegStatus: "pending",
    }));

    expect(result).toMatchObject({
      action: "waiting",
      reason: "fallback_not_ready",
    });
    expect(subject.sent).toHaveLength(0);
  });

  it("settles the reserve after terminal post-Pix failure and SLA", async () => {
    const subject = setup();

    const result = await subject.service.execute(provider({
      providerStatus: "failed",
      destinationLegStatus: "pending",
    }));

    expect(result).toMatchObject({
      action: "settled",
      reserveStatus: "settled",
      reason: "provider_failed_after_payment",
    });
    expect(subject.repository.settled).toBe(1);
    expect(subject.sent).toHaveLength(1);

    const transaction = subject.sent[0]!;
    expect(transaction.instructions).toHaveLength(2);
    expect(transaction.instructions[0]!.programId.equals(
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )).toBe(true);
    expect(transaction.instructions[0]!.data).toEqual(
      Buffer.from([1]),
    );
    expect(transaction.instructions[1]!.data).toEqual(
      discriminator("settle_contingency_reserve"),
    );
    expect(transaction.verifySignatures(true)).toBe(true);
    expect(
      transaction.signatures
        .filter(({ signature }) => signature !== null)
        .map(({ publicKey }) => publicKey.toBase58()),
    ).toEqual(expect.arrayContaining([
      subject.feePayer.publicKey.toBase58(),
      subject.attestationAuthority.publicKey.toBase58(),
    ]));
  });

  it("requires attention instead of spending an expired paid reserve", async () => {
    const subject = setup({
      now: new Date("2026-10-07T13:00:00Z"),
    });

    const result = await subject.service.execute(provider({
      providerStatus: "cancelled",
      destinationLegStatus: "pending",
    }));

    expect(result).toMatchObject({
      action: "attention_required",
      reason: "reserve_expired_after_payment",
    });
    expect(subject.sent).toHaveLength(0);
  });

  it("replays a finalized database state without another transaction", async () => {
    const subject = setup({ status: "settled" });

    const result = await subject.service.execute(provider({
      providerStatus: "failed",
      destinationLegStatus: "pending",
    }));

    expect(result).toMatchObject({
      action: "settled",
      reason: "already_finalized",
      signature: "settle-signature",
    });
    expect(subject.sent).toHaveLength(0);
  });

  it("returns no action when a settlement has no reserve", async () => {
    const subject = setup({ stored: false });

    await expect(subject.service.execute(provider())).resolves.toMatchObject({
      action: "none",
      reason: "no_reserve",
      reserveStatus: null,
    });
  });

  it("refuses to resolve a funded record missing on-chain", async () => {
    const subject = setup({ reserveExists: false });

    await expect(subject.service.execute(provider())).rejects.toThrow(
      "missing on-chain",
    );
    expect(subject.sent).toHaveLength(0);
  });

  it("rejects stored reserve addresses that differ from derivation", async () => {
    const subject = setup();
    subject.repository.value = {
      ...subject.repository.value!,
      reservePda: Keypair.generate().publicKey.toBase58(),
    };

    await expect(subject.service.execute(provider())).rejects.toThrow(
      "does not match its derived addresses",
    );
    expect(subject.sent).toHaveLength(0);
  });
});
