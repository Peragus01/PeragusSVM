import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  PrepareSolanaRollbackDemoService,
  SolanaRollbackDemoUnavailableError,
} from "../src/application/prepare-solana-rollback-demo.js";
import type { Settlement } from "../src/domain/settlement.js";
import {
  derivePeragusAddresses,
  LocalKeypairAuthoritySigner,
} from "../src/providers/peragus-solana-transaction.js";
import type { SettlementRepository } from "../src/repositories/settlement-repository.js";

const NOW = new Date("2026-10-12T03:00:00.000Z");
const SETTLEMENT_ID =
  "b2a3b4fc-7a59-41ec-9ef6-b9b39b1400a1";
const PROGRAM_ID = new PublicKey(
  "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w",
);
const U64_MAX = 18_446_744_073_709_551_615n;

function settlement(payer: PublicKey, recipient: PublicKey): Settlement {
  return {
    id: SETTLEMENT_ID,
    requestId: "rollback-demo-test",
    requestPayloadHash: "ab".repeat(32),
    requestPayload: {
      requestId: "rollback-demo-test",
      corridorId: "cd".repeat(32),
      payerWallet: payer.toBase58(),
      recipientWallet: recipient.toBase58(),
      sourceAmount: "25000000",
      destinationAmount: "37500",
      expiresAt: "2026-10-12T05:00:00.000Z",
    },
    corridorId: "cd".repeat(32),
    payerWallet: payer.toBase58(),
    recipientWallet: recipient.toBase58(),
    sourceAmount: "25000000",
    destinationAmount: "37500",
    expiresAt: new Date("2026-10-12T05:00:00.000Z"),
    status: "tokenized",
    version: 3,
    createdAt: new Date("2026-10-12T02:00:00.000Z"),
    updatedAt: new Date("2026-10-12T02:30:00.000Z"),
  };
}

function dependencies(input?: {
  payerBalance?: bigint;
  settlementPdaExists?: boolean;
}) {
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const attestation = Keypair.generate();
  const liquidity = Keypair.generate();
  const sourceMint = Keypair.generate().publicKey;
  const destinationMint = Keypair.generate().publicKey;
  const record = settlement(payer.publicKey, recipient.publicKey);
  const addresses = derivePeragusAddresses({
    backendSettlementId: record.id,
    corridorId: record.corridorId,
    payerWallet: record.payerWallet,
    recipientWallet: record.recipientWallet,
    sourceMint,
    destinationMint,
    liquidityAuthority: liquidity.publicKey,
    programId: PROGRAM_ID,
  }).addresses;
  const getTokenAccountBalance = vi.fn(async (address: PublicKey) => ({
    context: { apiVersion: "test", slot: 1 },
    value: {
      amount: address.equals(addresses.payerSource)
        ? (input?.payerBalance ?? 25_000_000n).toString()
        : address.equals(addresses.liquidityDestination)
          ? "10000000000"
          : "0",
      decimals: 6,
      uiAmount: null,
      uiAmountString: "0",
    },
  }));
  const service = new PrepareSolanaRollbackDemoService({
    settlements: {
      findById: vi.fn(async () => record),
    } as unknown as SettlementRepository,
    connection: {
      getLatestBlockhash: vi.fn(async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 900_000,
      })),
      getAccountInfo: vi.fn(async () =>
        input?.settlementPdaExists
          ? ({ data: Buffer.from([1]) } as never)
          : null,
      ),
      getTokenAccountBalance,
    } as unknown as Pick<
      Connection,
      | "getLatestBlockhash"
      | "getAccountInfo"
      | "getTokenAccountBalance"
    >,
    programId: PROGRAM_ID,
    sourceMint,
    destinationMint,
    attestationAuthority:
      new LocalKeypairAuthoritySigner(attestation),
    liquidityAuthority:
      new LocalKeypairAuthoritySigner(liquidity),
    now: () => NOW,
  });

  return { service, addresses };
}

describe("PrepareSolanaRollbackDemoService", () => {
  it("co-signs a transaction that can only fail on the second leg", async () => {
    const { service, addresses } = dependencies();

    const result = await service.execute(SETTLEMENT_ID);

    expect(result.scenario).toBe(
      "second_leg_insufficient_liquidity",
    );
    expect(result.injectedDestinationAmount).toBe(
      U64_MAX.toString(),
    );
    expect(result.availableDestinationBalance).toBe(
      "10000000000",
    );
    expect(result.tokenAccounts).toEqual({
      payerSource: addresses.payerSource.toBase58(),
      liquiditySource:
        addresses.liquiditySource.toBase58(),
      liquidityDestination:
        addresses.liquidityDestination.toBase58(),
      recipientDestination:
        addresses.recipientDestination.toBase58(),
    });

    const transaction = Transaction.from(
      Buffer.from(result.transactionBase64, "base64"),
    );
    expect(transaction.instructions).toHaveLength(2);
    expect(
      transaction.instructions[0]?.data.readBigUInt64LE(48),
    ).toBe(U64_MAX);
    expect(transaction.verifySignatures(false)).toBe(true);
    expect(transaction.verifySignatures(true)).toBe(false);
  });

  it("refuses the proof unless leg A can execute first", async () => {
    const { service } = dependencies({ payerBalance: 1n });

    await expect(
      service.execute(SETTLEMENT_ID),
    ).rejects.toBeInstanceOf(
      SolanaRollbackDemoUnavailableError,
    );
  });

  it("refuses the proof after the settlement PDA exists", async () => {
    const { service } = dependencies({
      settlementPdaExists: true,
    });

    await expect(
      service.execute(SETTLEMENT_ID),
    ).rejects.toBeInstanceOf(
      SolanaRollbackDemoUnavailableError,
    );
  });
});
