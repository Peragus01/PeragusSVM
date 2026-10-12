import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  PrepareSolanaSettlementService,
  SolanaSettlementExpiredError,
  SolanaSettlementNotFoundError,
  SolanaSettlementNotReadyError,
} from "../src/application/prepare-solana-settlement.js";
import type {
  Settlement,
  SettlementStatus,
} from "../src/domain/settlement.js";
import {
  loadConfiguredSolanaAuthority,
  parseSolanaKeypair,
} from "../src/providers/local-solana-authority.js";
import { LocalKeypairAuthoritySigner } from "../src/providers/peragus-solana-transaction.js";
import type { SettlementRepository } from "../src/repositories/settlement-repository.js";
import type {
  SaveSolanaSettlementPreparationInput,
  SolanaSettlementPreparationRepository,
} from "../src/repositories/solana-settlement-preparation-repository.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const SETTLEMENT_ID =
  "b2a3b4fc-7a59-41ec-9ef6-b9b39b1400a1";
const PROGRAM_ID =
  "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w";

function createSettlement(
  status: SettlementStatus = "tokenized",
): Settlement {
  const payer = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();

  return {
    id: SETTLEMENT_ID,
    requestId: "solana-prepare-test",
    requestPayloadHash: "ab".repeat(32),
    requestPayload: {
      requestId: "solana-prepare-test",
      corridorId: "cd".repeat(32),
      payerWallet: payer,
      recipientWallet: recipient,
      sourceAmount: "25000000",
      destinationAmount: "37500",
      expiresAt: "2026-10-07T13:00:00.000Z",
    },
    corridorId: "cd".repeat(32),
    payerWallet: payer,
    recipientWallet: recipient,
    sourceAmount: "25000000",
    destinationAmount: "37500",
    expiresAt: new Date("2026-10-07T13:00:00.000Z"),
    status,
    version: 4,
    createdAt: new Date("2026-10-07T11:00:00.000Z"),
    updatedAt: new Date("2026-10-07T11:30:00.000Z"),
  };
}

function createDependencies(
  settlement: Settlement | null = createSettlement(),
) {
  const attestation = Keypair.generate();
  const liquidity = Keypair.generate();
  const savedInputs: SaveSolanaSettlementPreparationInput[] = [];
  let saved = true;
  let returnedPda: string | undefined;

  const settlements = {
    findById: vi.fn(async () => settlement),
  } as unknown as SettlementRepository;

  const preparations: SolanaSettlementPreparationRepository = {
    async savePrepared(input) {
      savedInputs.push(input);

      return {
        settlementPda: returnedPda ?? input.settlementPda,
        saved,
      };
    },
  };

  const getLatestBlockhash = vi.fn(async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 500_000,
  }));

  const service = new PrepareSolanaSettlementService({
    settlements,
    preparations,
    connection: {
      getLatestBlockhash,
    } as Pick<Connection, "getLatestBlockhash">,
    programId: new PublicKey(PROGRAM_ID),
    sourceMint: Keypair.generate().publicKey,
    destinationMint: Keypair.generate().publicKey,
    attestationAuthority:
      new LocalKeypairAuthoritySigner(attestation),
    liquidityAuthority:
      new LocalKeypairAuthoritySigner(liquidity),
    now: () => NOW,
  });

  return {
    service,
    savedInputs,
    getLatestBlockhash,
    setSaved(value: boolean) {
      saved = value;
    },
    setReturnedPda(value: string) {
      returnedPda = value;
    },
  };
}

describe("PrepareSolanaSettlementService", () => {
  it("creates a partially signed transaction for a tokenized settlement", async () => {
    const dependencies = createDependencies();

    const result = await dependencies.service.execute(
      SETTLEMENT_ID,
    );

    expect(result.settlementId).toBe(SETTLEMENT_ID);
    expect(result.idempotentReplay).toBe(false);
    expect(result.requiredExternalSigner).toBe(result.feePayer);
    expect(result.messageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(dependencies.savedInputs).toEqual([
      {
        settlementId: SETTLEMENT_ID,
        expectedVersion: 4,
        settlementPda: result.settlementPda,
      },
    ]);

    const transaction = Transaction.from(
      Buffer.from(result.transactionBase64, "base64"),
    );

    expect(transaction.instructions).toHaveLength(2);
    expect(transaction.verifySignatures(false)).toBe(true);
    expect(transaction.verifySignatures(true)).toBe(false);
  });

  it("reports an idempotent replay when the PDA was already saved", async () => {
    const dependencies = createDependencies();
    dependencies.setSaved(false);

    const result = await dependencies.service.execute(
      SETTLEMENT_ID,
    );

    expect(result.idempotentReplay).toBe(true);
  });

  it("rejects an unknown settlement before contacting Solana", async () => {
    const dependencies = createDependencies(null);

    await expect(
      dependencies.service.execute(SETTLEMENT_ID),
    ).rejects.toBeInstanceOf(SolanaSettlementNotFoundError);
    expect(dependencies.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it("rejects a settlement that has not reached tokenized", async () => {
    const dependencies = createDependencies(
      createSettlement("awaiting_pix"),
    );

    await expect(
      dependencies.service.execute(SETTLEMENT_ID),
    ).rejects.toBeInstanceOf(SolanaSettlementNotReadyError);
    expect(dependencies.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it("rejects an expired settlement before contacting Solana", async () => {
    const settlement = createSettlement();
    settlement.expiresAt = NOW;
    const dependencies = createDependencies(settlement);

    await expect(
      dependencies.service.execute(SETTLEMENT_ID),
    ).rejects.toBeInstanceOf(SolanaSettlementExpiredError);
    expect(dependencies.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it("blocks a persistence result containing another PDA", async () => {
    const dependencies = createDependencies();
    dependencies.setReturnedPda(
      Keypair.generate().publicKey.toBase58(),
    );

    await expect(
      dependencies.service.execute(SETTLEMENT_ID),
    ).rejects.toThrow("unexpected Solana PDA");
  });
});

describe("local Solana authority parser", () => {
  it("loads a valid Solana keypair array without exposing it", () => {
    const expected = Keypair.generate();
    const parsed = parseSolanaKeypair(
      JSON.stringify(Array.from(expected.secretKey)),
      "test signer",
    );

    expect(parsed.publicKey.equals(expected.publicKey)).toBe(true);
  });

  it("rejects malformed key material", () => {
    expect(() => parseSolanaKeypair(
      JSON.stringify([1, 2, 3]),
      "test signer",
    )).toThrow("64-byte Solana keypair array");
  });

  it("loads a base64 keypair without writing a cloud secret to disk", () => {
    const expected = Keypair.generate();
    const keypairBase64 = Buffer.from(
      JSON.stringify(Array.from(expected.secretKey)),
      "utf8",
    ).toString("base64");

    const authority = loadConfiguredSolanaAuthority({
      keypairBase64,
      label: "TEST_SIGNER",
    });

    expect(authority.publicKey.equals(expected.publicKey)).toBe(true);
  });

  it("rejects ambiguous signer configuration", () => {
    expect(() => loadConfiguredSolanaAuthority({
      filePath: "/tmp/test-keypair.json",
      keypairBase64: "Zm9v",
      label: "TEST_SIGNER",
    })).toThrow("either KEYPAIR_PATH or KEYPAIR_BASE64");
  });
});
