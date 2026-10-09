import { randomUUID } from "node:crypto";

import {
  type Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  ConfirmSolanaSettlementService,
  SolanaConfirmationSettlementNotFoundError,
  SolanaConfirmationSettlementNotReadyError,
  SolanaSettlementNotPreparedError,
  SolanaTransactionMismatchError,
  SolanaTransactionNotConfirmedError,
} from "../src/application/confirm-solana-settlement.js";
import type { Settlement } from "../src/domain/settlement.js";
import {
  buildPeragusAtomicSettlementTransaction,
  derivePeragusSettlementId,
} from "../src/providers/peragus-solana-transaction.js";
import type { SettlementRepository } from "../src/repositories/settlement-repository.js";
import type {
  SolanaSettlementConfirmationRepository,
  SolanaSettlementConfirmationState,
} from "../src/repositories/solana-settlement-confirmation-repository.js";

const SIGNATURE = "1".repeat(88);

function createSettlement(
  overrides: Partial<Settlement> = {},
): Settlement {
  const now = new Date("2026-10-07T20:00:00.000Z");
  const requestPayload = {
    requestId: "solana-confirmation-test",
    corridorId: "ab".repeat(32),
    payerWallet: Keypair.generate().publicKey.toBase58(),
    recipientWallet:
      Keypair.generate().publicKey.toBase58(),
    sourceAmount: "25000000",
    destinationAmount: "37500",
    expiresAt: new Date(
      now.getTime() + 3_600_000,
    ).toISOString(),
  };

  return {
    id: randomUUID(),
    requestId: requestPayload.requestId,
    requestPayloadHash: "a".repeat(64),
    requestPayload,
    corridorId: requestPayload.corridorId,
    payerWallet: requestPayload.payerWallet,
    recipientWallet: requestPayload.recipientWallet,
    sourceAmount: requestPayload.sourceAmount,
    destinationAmount: requestPayload.destinationAmount,
    expiresAt: new Date(requestPayload.expiresAt),
    status: "tokenized",
    version: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function settlementPda(
  settlementId: string,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("settlement"),
      derivePeragusSettlementId(settlementId),
    ],
    programId,
  )[0];
}

function createHarness(options: {
  settlement?: Settlement | null;
  state?: SolanaSettlementConfirmationState | null;
  confirmed?: boolean;
  payerWallet?: string;
  transactionDestinationAmount?: string;
  includeLogs?: boolean;
  accountOwner?: PublicKey;
} = {}) {
  const programId = Keypair.generate().publicKey;
  const sourceMint = Keypair.generate().publicKey;
  const destinationMint = Keypair.generate().publicKey;
  const attestationAuthority =
    Keypair.generate().publicKey;
  const liquidityAuthority = Keypair.generate().publicKey;
  const settlement = options.settlement === undefined
    ? createSettlement()
    : options.settlement;
  const pda = settlement
    ? settlementPda(settlement.id, programId)
    : Keypair.generate().publicKey;
  const payer = new PublicKey(
    options.payerWallet
    ?? settlement?.payerWallet
    ?? Keypair.generate().publicKey,
  );
  const transaction = settlement
    ? buildPeragusAtomicSettlementTransaction(
        {
          backendSettlementId: settlement.id,
          corridorId: settlement.corridorId,
          payerWallet: payer,
          recipientWallet: settlement.recipientWallet,
          sourceAmount: settlement.sourceAmount,
          destinationAmount:
            options.transactionDestinationAmount
            ?? settlement.destinationAmount,
          expiresAt: settlement.expiresAt,
          sourceMint,
          destinationMint,
          attestationAuthority,
          liquidityAuthority,
          programId,
          recentBlockhash:
            Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 1,
        },
        new Date(0),
      ).transaction
    : new Transaction({
        feePayer: payer,
        recentBlockhash:
          Keypair.generate().publicKey.toBase58(),
      }).add(
        new TransactionInstruction({
          programId,
          keys: [],
          data: Buffer.alloc(8),
        }),
      );

  const state = options.state === undefined
    ? settlement
      ? {
          settlementId: settlement.id,
          status: settlement.status,
          version: settlement.version,
          settlementPda: pda.toBase58(),
          createSignature: null,
          executeSignature: null,
        }
      : null
    : options.state;
  const settlements = {
    createOrGet: vi.fn(),
    findById: vi.fn(async () => settlement),
    findByRequestId: vi.fn(),
    updateStatus: vi.fn(),
  } as unknown as SettlementRepository;
  const confirmations = {
    findBySettlementId: vi.fn(async () => state),
    confirmSettled: vi.fn(async () => ({
      settlementId: settlement!.id,
      status: "settled" as const,
      version: settlement!.version + 2,
      settlementPda: pda.toBase58(),
      createSignature: SIGNATURE,
      executeSignature: SIGNATURE,
      saved: true,
    })),
  } satisfies SolanaSettlementConfirmationRepository;
  const confirmed = options.confirmed ?? true;
  const connection = {
    getSignatureStatuses: vi.fn(async () => ({
      context: { slot: 120 },
      value: [confirmed
        ? {
            slot: 120,
            confirmations: 1,
            err: null,
            confirmationStatus: "confirmed" as const,
          }
        : null],
    })),
    getTransaction: vi.fn(async () => confirmed
      ? {
          slot: 120,
          transaction: {
            message: transaction.compileMessage(),
            signatures: [SIGNATURE],
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [],
            postBalances: [],
            logMessages: options.includeLogs === false
              ? []
              : [
                  "Program log: Leg A CPI succeeded",
                  "Program log: Leg B CPI succeeded",
                ],
          },
          blockTime: 1_791_399_600,
          version: "legacy" as const,
        }
      : null),
    getAccountInfo: vi.fn(async () => ({
      data: Buffer.from([1]),
      executable: false,
      lamports: 1,
      owner: options.accountOwner ?? programId,
      rentEpoch: 0,
    })),
  } as unknown as Pick<
    Connection,
    | "getSignatureStatuses"
    | "getTransaction"
    | "getAccountInfo"
  >;
  const service = new ConfirmSolanaSettlementService({
    settlements,
    confirmations,
    connection,
    programId,
    sourceMint,
    destinationMint,
    attestationAuthority,
    liquidityAuthority,
  });

  return {
    confirmations,
    connection,
    pda,
    programId,
    service,
    settlement,
  };
}

describe("ConfirmSolanaSettlementService", () => {
  it("verifies the transaction before persisting settled", async () => {
    const harness = createHarness();

    const result = await harness.service.execute(
      harness.settlement!.id,
      SIGNATURE,
    );

    expect(result).toEqual({
      settlementId: harness.settlement!.id,
      settlementPda: harness.pda.toBase58(),
      signature: SIGNATURE,
      slot: 120,
      status: "settled",
      version: 5,
      idempotentReplay: false,
    });
    expect(
      harness.confirmations.confirmSettled,
    ).toHaveBeenCalledWith({
      settlementId: harness.settlement!.id,
      expectedVersion: 3,
      settlementPda: harness.pda.toBase58(),
      signature: SIGNATURE,
    });
  });

  it("revalidates an idempotent settled replay", async () => {
    const settlement = createSettlement({
      status: "settled",
      version: 5,
    });
    const harness = createHarness({ settlement });
    const actualPda = settlementPda(
      settlement.id,
      harness.programId,
    );

    harness.confirmations.findBySettlementId = vi.fn(
      async () => ({
        settlementId: settlement.id,
        status: "settled",
        version: 5,
        settlementPda: actualPda.toBase58(),
        createSignature: SIGNATURE,
        executeSignature: SIGNATURE,
      }),
    );
    harness.confirmations.confirmSettled = vi.fn(
      async () => ({
        settlementId: settlement.id,
        status: "settled",
        version: 5,
        settlementPda: actualPda.toBase58(),
        createSignature: SIGNATURE,
        executeSignature: SIGNATURE,
        saved: false,
      }),
    );

    const result = await harness.service.execute(
      settlement.id,
      SIGNATURE,
    );

    expect(result.idempotentReplay).toBe(true);
    expect(result.slot).toBe(120);
  });

  it("rejects an unknown settlement", async () => {
    const harness = createHarness({ settlement: null });

    await expect(
      harness.service.execute(randomUUID(), SIGNATURE),
    ).rejects.toBeInstanceOf(
      SolanaConfirmationSettlementNotFoundError,
    );
  });

  it("rejects a settlement outside tokenized", async () => {
    const settlement = createSettlement({
      status: "pix_confirmed",
    });
    const harness = createHarness({ settlement });

    await expect(
      harness.service.execute(settlement.id, SIGNATURE),
    ).rejects.toBeInstanceOf(
      SolanaConfirmationSettlementNotReadyError,
    );
  });

  it("rejects a settlement without a prepared PDA", async () => {
    const settlement = createSettlement();
    const harness = createHarness({
      settlement,
      state: {
        settlementId: settlement.id,
        status: "tokenized",
        version: settlement.version,
        settlementPda: null,
        createSignature: null,
        executeSignature: null,
      },
    });

    await expect(
      harness.service.execute(settlement.id, SIGNATURE),
    ).rejects.toBeInstanceOf(
      SolanaSettlementNotPreparedError,
    );
  });

  it("rejects an unconfirmed signature", async () => {
    const harness = createHarness({ confirmed: false });

    await expect(
      harness.service.execute(
        harness.settlement!.id,
        SIGNATURE,
      ),
    ).rejects.toBeInstanceOf(
      SolanaTransactionNotConfirmedError,
    );
  });

  it("rejects a different transaction fee payer", async () => {
    const harness = createHarness({
      payerWallet: Keypair.generate().publicKey.toBase58(),
    });

    await expect(
      harness.service.execute(
        harness.settlement!.id,
        SIGNATURE,
      ),
    ).rejects.toBeInstanceOf(
      SolanaTransactionMismatchError,
    );
  });

  it("rejects different settlement instruction data", async () => {
    const harness = createHarness({
      transactionDestinationAmount: "37501",
    });

    await expect(
      harness.service.execute(
        harness.settlement!.id,
        SIGNATURE,
      ),
    ).rejects.toBeInstanceOf(
      SolanaTransactionMismatchError,
    );
  });

  it("rejects a transaction without atomic completion logs", async () => {
    const harness = createHarness({ includeLogs: false });

    await expect(
      harness.service.execute(
        harness.settlement!.id,
        SIGNATURE,
      ),
    ).rejects.toBeInstanceOf(
      SolanaTransactionMismatchError,
    );
  });

  it("rejects a settlement account owned by another program", async () => {
    const harness = createHarness({
      accountOwner: Keypair.generate().publicKey,
    });

    await expect(
      harness.service.execute(
        harness.settlement!.id,
        SIGNATURE,
      ),
    ).rejects.toBeInstanceOf(
      SolanaTransactionMismatchError,
    );
  });
});
