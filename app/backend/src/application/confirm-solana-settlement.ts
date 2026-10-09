import {
  type Connection,
  type Message,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { SettlementStatus } from "../domain/settlement.js";
import {
  buildPeragusAtomicSettlementTransaction,
  derivePeragusSettlementId,
} from "../providers/peragus-solana-transaction.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";
import {
  SolanaSettlementConfirmationPersistenceError,
  type SolanaSettlementConfirmationRepository,
} from "../repositories/solana-settlement-confirmation-repository.js";

const SETTLEMENT_SEED = Buffer.from("settlement");

export class SolanaConfirmationSettlementNotFoundError
  extends Error
{
  constructor(public readonly settlementId: string) {
    super(`Settlement not found: ${settlementId}`);
    this.name =
      "SolanaConfirmationSettlementNotFoundError";
  }
}

export class SolanaConfirmationSettlementNotReadyError
  extends Error
{
  constructor(
    public readonly settlementId: string,
    public readonly status: SettlementStatus,
  ) {
    super(
      `Settlement ${settlementId} cannot be confirmed from status ${status}`,
    );
    this.name =
      "SolanaConfirmationSettlementNotReadyError";
  }
}

export class SolanaSettlementNotPreparedError extends Error {
  constructor(public readonly settlementId: string) {
    super(`Settlement has no prepared Solana PDA: ${settlementId}`);
    this.name = "SolanaSettlementNotPreparedError";
  }
}

export class SolanaTransactionNotConfirmedError extends Error {
  constructor(public readonly signature: string) {
    super(`Solana transaction is not confirmed: ${signature}`);
    this.name = "SolanaTransactionNotConfirmedError";
  }
}

export class SolanaTransactionMismatchError extends Error {
  constructor(public readonly reason: string) {
    super(`Solana transaction does not match settlement: ${reason}`);
    this.name = "SolanaTransactionMismatchError";
  }
}

export class SolanaSettlementConfirmationConflictError
  extends Error
{
  constructor(public readonly settlementId: string) {
    super(
      `Settlement changed while confirming Solana transaction: ${settlementId}`,
    );
    this.name =
      "SolanaSettlementConfirmationConflictError";
  }
}

export interface ConfirmSolanaSettlementResult {
  settlementId: string;
  settlementPda: string;
  signature: string;
  slot: number;
  status: "settled";
  version: number;
  idempotentReplay: boolean;
}

export interface SolanaSettlementConfirmer {
  execute(
    settlementId: string,
    signature: string,
  ): Promise<ConfirmSolanaSettlementResult>;
}

export interface ConfirmSolanaSettlementOptions {
  settlements: SettlementRepository;
  confirmations: SolanaSettlementConfirmationRepository;
  connection: Pick<
    Connection,
    | "getSignatureStatuses"
    | "getTransaction"
    | "getAccountInfo"
  >;
  programId: PublicKey;
  sourceMint: PublicKey;
  destinationMint: PublicKey;
  attestationAuthority: PublicKey;
  liquidityAuthority: PublicKey;
}

function deriveSettlementPda(
  settlementId: string,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      SETTLEMENT_SEED,
      derivePeragusSettlementId(settlementId),
    ],
    programId,
  )[0];
}

function instructionsMatch(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
): boolean {
  return actual.programId.equals(expected.programId)
    && actual.data.equals(expected.data)
    && actual.keys.length === expected.keys.length
    && actual.keys.every((key, index) => {
      const expectedKey = expected.keys[index];

      return expectedKey !== undefined
        && key.pubkey.equals(expectedKey.pubkey)
        && key.isSigner === expectedKey.isSigner
        && key.isWritable === expectedKey.isWritable;
    });
}

export class ConfirmSolanaSettlementService
  implements SolanaSettlementConfirmer
{
  constructor(
    private readonly options: ConfirmSolanaSettlementOptions,
  ) {}

  async execute(
    settlementId: string,
    signature: string,
  ): Promise<ConfirmSolanaSettlementResult> {
    const settlement = await this.options.settlements.findById(
      settlementId,
    );

    if (!settlement) {
      throw new SolanaConfirmationSettlementNotFoundError(
        settlementId,
      );
    }

    const state =
      await this.options.confirmations.findBySettlementId(
        settlement.id,
      );
    const expectedPda = deriveSettlementPda(
      settlement.id,
      this.options.programId,
    ).toBase58();

    const isIdempotentReplay =
      settlement.status === "settled"
      && state?.status === "settled"
      && state.settlementPda === expectedPda
      && state.createSignature === signature
      && state.executeSignature === signature;

    if (
      settlement.status !== "tokenized"
      && !isIdempotentReplay
    ) {
      throw new SolanaConfirmationSettlementNotReadyError(
        settlement.id,
        settlement.status,
      );
    }

    if (!state || state.settlementPda === null) {
      throw new SolanaSettlementNotPreparedError(
        settlement.id,
      );
    }

    if (
      !isIdempotentReplay
      && (
        state.status !== "tokenized"
        || state.version !== settlement.version
      )
    ) {
      throw new SolanaSettlementNotPreparedError(
        settlement.id,
      );
    }

    if (state.settlementPda !== expectedPda) {
      throw new SolanaTransactionMismatchError(
        "persisted settlement PDA is unexpected",
      );
    }

    const statuses =
      await this.options.connection.getSignatureStatuses(
        [signature],
        {
          searchTransactionHistory: true,
        },
      );
    const signatureStatus = statuses.value[0];

    if (
      !signatureStatus
      || signatureStatus.err !== null
      || (
        signatureStatus.confirmationStatus !== "confirmed"
        && signatureStatus.confirmationStatus !== "finalized"
      )
    ) {
      throw new SolanaTransactionNotConfirmedError(signature);
    }

    const transaction =
      await this.options.connection.getTransaction(
        signature,
        {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      );

    if (
      !transaction
      || !transaction.meta
      || transaction.meta.err !== null
    ) {
      throw new SolanaTransactionNotConfirmedError(signature);
    }

    if (
      transaction.version !== undefined
      && transaction.version !== "legacy"
    ) {
      throw new SolanaTransactionMismatchError(
        "transaction is not in legacy format",
      );
    }

    if (transaction.transaction.signatures[0] !== signature) {
      throw new SolanaTransactionMismatchError(
        "signature is not the fee-payer signature",
      );
    }

    const message = transaction.transaction.message as Message;
    const accountKeys = message.accountKeys;
    const feePayer = accountKeys[0];

    if (
      !feePayer
      || feePayer.toBase58() !== settlement.payerWallet
    ) {
      throw new SolanaTransactionMismatchError(
        "fee payer does not match settlement payer",
      );
    }

    const submitted = Transaction.populate(message);
    const expectedTransaction =
      buildPeragusAtomicSettlementTransaction(
        {
          backendSettlementId: settlement.id,
          corridorId: settlement.corridorId,
          payerWallet: settlement.payerWallet,
          recipientWallet: settlement.recipientWallet,
          sourceAmount: settlement.sourceAmount,
          destinationAmount:
            settlement.destinationAmount,
          expiresAt: settlement.expiresAt,
          sourceMint: this.options.sourceMint,
          destinationMint: this.options.destinationMint,
          attestationAuthority:
            this.options.attestationAuthority,
          liquidityAuthority:
            this.options.liquidityAuthority,
          programId: this.options.programId,
          recentBlockhash: message.recentBlockhash,
          lastValidBlockHeight: 0,
        },
        new Date(0),
      ).transaction;
    const expected = Transaction.populate(
      expectedTransaction.compileMessage(),
    );

    if (
      submitted.instructions.length !== 2
      || submitted.instructions.length
        !== expected.instructions.length
      || !submitted.instructions.every(
        (instruction, index) => {
          const expectedInstruction =
            expected.instructions[index];

          return expectedInstruction !== undefined
            && instructionsMatch(
              instruction,
              expectedInstruction,
            );
        },
      )
    ) {
      throw new SolanaTransactionMismatchError(
        "transaction instructions do not match the prepared settlement",
      );
    }

    const logs = transaction.meta.logMessages ?? [];

    if (
      !logs.includes("Program log: Leg A CPI succeeded")
      || !logs.includes("Program log: Leg B CPI succeeded")
    ) {
      throw new SolanaTransactionMismatchError(
        "atomic settlement completion logs are absent",
      );
    }

    const settlementAccount =
      await this.options.connection.getAccountInfo(
        new PublicKey(expectedPda),
        {
          commitment: "confirmed",
          minContextSlot: transaction.slot,
        },
      );

    if (
      !settlementAccount
      || !settlementAccount.owner.equals(
        this.options.programId,
      )
      || settlementAccount.data.length === 0
    ) {
      throw new SolanaTransactionMismatchError(
        "settlement PDA is not owned by the Peragus program",
      );
    }

    try {
      const confirmed =
        await this.options.confirmations.confirmSettled({
          settlementId: settlement.id,
          expectedVersion: settlement.version,
          settlementPda: expectedPda,
          signature,
        });

      return {
        settlementId: confirmed.settlementId,
        settlementPda: expectedPda,
        signature,
        slot: transaction.slot,
        status: "settled",
        version: confirmed.version,
        idempotentReplay: !confirmed.saved,
      };
    } catch (error) {
      if (
        error instanceof
          SolanaSettlementConfirmationPersistenceError
      ) {
        throw new SolanaSettlementConfirmationConflictError(
          settlement.id,
        );
      }

      throw error;
    }
  }
}
