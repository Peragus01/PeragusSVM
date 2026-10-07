import {
  type Connection,
  PublicKey,
} from "@solana/web3.js";

import type { SettlementStatus } from "../domain/settlement.js";
import {
  buildPeragusAtomicSettlementTransaction,
  partiallySignPeragusTransaction,
  type PartiallySignedPeragusTransaction,
  type SolanaTransactionAuthoritySigner,
} from "../providers/peragus-solana-transaction.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";
import type { SolanaSettlementPreparationRepository } from "../repositories/solana-settlement-preparation-repository.js";

export class SolanaSettlementNotFoundError extends Error {
  constructor(public readonly settlementId: string) {
    super(`Settlement not found: ${settlementId}`);
    this.name = "SolanaSettlementNotFoundError";
  }
}

export class SolanaSettlementNotReadyError extends Error {
  constructor(
    public readonly settlementId: string,
    public readonly status: SettlementStatus,
  ) {
    super(
      `Settlement ${settlementId} cannot be prepared from status ${status}`,
    );
    this.name = "SolanaSettlementNotReadyError";
  }
}

export class SolanaSettlementExpiredError extends Error {
  constructor(public readonly settlementId: string) {
    super(`Settlement expired: ${settlementId}`);
    this.name = "SolanaSettlementExpiredError";
  }
}

export interface PrepareSolanaSettlementResult
  extends PartiallySignedPeragusTransaction {
  settlementId: string;
  idempotentReplay: boolean;
}

export interface SolanaSettlementPreparer {
  execute(
    settlementId: string,
  ): Promise<PrepareSolanaSettlementResult>;
}

export interface PrepareSolanaSettlementOptions {
  settlements: SettlementRepository;
  preparations: SolanaSettlementPreparationRepository;
  connection: Pick<Connection, "getLatestBlockhash">;
  programId: PublicKey;
  sourceMint: PublicKey;
  destinationMint: PublicKey;
  attestationAuthority: SolanaTransactionAuthoritySigner;
  liquidityAuthority: SolanaTransactionAuthoritySigner;
  now?: () => Date;
}

export class PrepareSolanaSettlementService
  implements SolanaSettlementPreparer
{
  private readonly now: () => Date;

  constructor(
    private readonly options: PrepareSolanaSettlementOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    settlementId: string,
  ): Promise<PrepareSolanaSettlementResult> {
    const settlement = await this.options.settlements.findById(
      settlementId,
    );

    if (!settlement) {
      throw new SolanaSettlementNotFoundError(settlementId);
    }

    if (settlement.status !== "tokenized") {
      throw new SolanaSettlementNotReadyError(
        settlement.id,
        settlement.status,
      );
    }

    const now = this.now();

    if (settlement.expiresAt.getTime() <= now.getTime()) {
      throw new SolanaSettlementExpiredError(settlement.id);
    }

    const latestBlockhash =
      await this.options.connection.getLatestBlockhash(
        "confirmed",
      );

    const prepared = buildPeragusAtomicSettlementTransaction(
      {
        backendSettlementId: settlement.id,
        corridorId: settlement.corridorId,
        payerWallet: settlement.payerWallet,
        recipientWallet: settlement.recipientWallet,
        sourceAmount: settlement.sourceAmount,
        destinationAmount: settlement.destinationAmount,
        expiresAt: settlement.expiresAt,
        sourceMint: this.options.sourceMint,
        destinationMint: this.options.destinationMint,
        attestationAuthority:
          this.options.attestationAuthority.publicKey,
        liquidityAuthority:
          this.options.liquidityAuthority.publicKey,
        programId: this.options.programId,
        recentBlockhash: latestBlockhash.blockhash,
        lastValidBlockHeight:
          latestBlockhash.lastValidBlockHeight,
      },
      now,
    );

    const partiallySigned =
      await partiallySignPeragusTransaction(prepared, {
        payerWallet: settlement.payerWallet,
        attestationAuthority:
          this.options.attestationAuthority,
        liquidityAuthority:
          this.options.liquidityAuthority,
      });

    const saved = await this.options.preparations.savePrepared({
      settlementId: settlement.id,
      expectedVersion: settlement.version,
      settlementPda: partiallySigned.settlementPda,
    });

    if (saved.settlementPda !== partiallySigned.settlementPda) {
      throw new Error(
        `Settlement ${settlement.id} has an unexpected Solana PDA`,
      );
    }

    return {
      ...partiallySigned,
      settlementId: settlement.id,
      idempotentReplay: !saved.saved,
    };
  }
}
