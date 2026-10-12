import {
  type Connection,
  PublicKey,
} from "@solana/web3.js";

import {
  SolanaSettlementExpiredError,
  SolanaSettlementNotFoundError,
  SolanaSettlementNotReadyError,
} from "./prepare-solana-settlement.js";
import {
  buildPeragusAtomicSettlementTransaction,
  derivePeragusAddresses,
  partiallySignPeragusTransaction,
  type PartiallySignedPeragusTransaction,
  type SolanaTransactionAuthoritySigner,
} from "../providers/peragus-solana-transaction.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

const U64_MAX = 18_446_744_073_709_551_615n;

export class SolanaRollbackDemoUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Atomic rollback demo is unavailable: ${reason}`);
    this.name = "SolanaRollbackDemoUnavailableError";
  }
}

export interface PrepareSolanaRollbackDemoResult
  extends PartiallySignedPeragusTransaction {
  settlementId: string;
  scenario: "second_leg_insufficient_liquidity";
  injectedDestinationAmount: string;
  availableDestinationBalance: string;
  tokenAccounts: {
    payerSource: string;
    liquiditySource: string;
    liquidityDestination: string;
    recipientDestination: string;
  };
}

export interface SolanaRollbackDemoPreparer {
  execute(
    settlementId: string,
  ): Promise<PrepareSolanaRollbackDemoResult>;
}

export interface PrepareSolanaRollbackDemoOptions {
  settlements: SettlementRepository;
  connection: Pick<
    Connection,
    | "getLatestBlockhash"
    | "getAccountInfo"
    | "getTokenAccountBalance"
  >;
  programId: PublicKey;
  sourceMint: PublicKey;
  destinationMint: PublicKey;
  attestationAuthority: SolanaTransactionAuthoritySigner;
  liquidityAuthority: SolanaTransactionAuthoritySigner;
  now?: () => Date;
}

/**
 * Builds a Devnet-only fault-injection transaction. The first Token-2022
 * transfer has sufficient funds, while the second requests u64::MAX and is
 * therefore guaranteed to fail for the configured demo account. Since create
 * and execute share one Solana transaction, the settlement PDA and leg A are
 * rolled back together.
 */
export class PrepareSolanaRollbackDemoService
  implements SolanaRollbackDemoPreparer
{
  private readonly now: () => Date;

  constructor(
    private readonly options: PrepareSolanaRollbackDemoOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    settlementId: string,
  ): Promise<PrepareSolanaRollbackDemoResult> {
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

    const { addresses } = derivePeragusAddresses({
      backendSettlementId: settlement.id,
      corridorId: settlement.corridorId,
      payerWallet: settlement.payerWallet,
      recipientWallet: settlement.recipientWallet,
      sourceMint: this.options.sourceMint,
      destinationMint: this.options.destinationMint,
      liquidityAuthority:
        this.options.liquidityAuthority.publicKey,
      programId: this.options.programId,
    });

    const [
      settlementAccount,
      payerSource,
      liquiditySource,
      liquidityDestination,
      recipientDestination,
    ] = await Promise.all([
      this.options.connection.getAccountInfo(
        addresses.settlement,
        "confirmed",
      ),
      this.options.connection.getTokenAccountBalance(
        addresses.payerSource,
        "confirmed",
      ),
      this.options.connection.getTokenAccountBalance(
        addresses.liquiditySource,
        "confirmed",
      ),
      this.options.connection.getTokenAccountBalance(
        addresses.liquidityDestination,
        "confirmed",
      ),
      this.options.connection.getTokenAccountBalance(
        addresses.recipientDestination,
        "confirmed",
      ),
    ]);

    if (settlementAccount) {
      throw new SolanaRollbackDemoUnavailableError(
        "the settlement PDA already exists",
      );
    }

    if (
      BigInt(payerSource.value.amount)
      < BigInt(settlement.sourceAmount)
    ) {
      throw new SolanaRollbackDemoUnavailableError(
        "leg A does not have enough demo funds",
      );
    }

    const availableDestinationBalance = BigInt(
      liquidityDestination.value.amount,
    );
    if (availableDestinationBalance >= U64_MAX) {
      throw new SolanaRollbackDemoUnavailableError(
        "leg B cannot be forced to fail safely",
      );
    }

    const latest =
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
        destinationAmount: U64_MAX,
        expiresAt: settlement.expiresAt,
        sourceMint: this.options.sourceMint,
        destinationMint: this.options.destinationMint,
        attestationAuthority:
          this.options.attestationAuthority.publicKey,
        liquidityAuthority:
          this.options.liquidityAuthority.publicKey,
        programId: this.options.programId,
        recentBlockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      now,
    );
    const signed = await partiallySignPeragusTransaction(
      prepared,
      {
        payerWallet: settlement.payerWallet,
        attestationAuthority:
          this.options.attestationAuthority,
        liquidityAuthority:
          this.options.liquidityAuthority,
      },
    );

    return {
      ...signed,
      settlementId: settlement.id,
      scenario: "second_leg_insufficient_liquidity",
      injectedDestinationAmount: U64_MAX.toString(),
      availableDestinationBalance:
        availableDestinationBalance.toString(),
      tokenAccounts: {
        payerSource: addresses.payerSource.toBase58(),
        liquiditySource: addresses.liquiditySource.toBase58(),
        liquidityDestination:
          addresses.liquidityDestination.toBase58(),
        recipientDestination:
          addresses.recipientDestination.toBase58(),
      },
    };
  }
}
