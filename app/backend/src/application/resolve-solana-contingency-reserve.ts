import {
  PublicKey,
  type Connection,
  type Transaction,
} from "@solana/web3.js";

import {
  buildRefundContingencyReserveTransaction,
  buildSettleContingencyReserveTransaction,
  deriveContingencyReserveAddresses,
} from "../providers/peragus-contingency-reserve-transaction.js";
import type { SolanaTransactionAuthoritySigner } from "../providers/peragus-solana-transaction.js";
import type {
  SolanaContingencyReserve,
  SolanaContingencyReserveRepository,
} from "../repositories/solana-contingency-reserve-repository.js";

const TERMINAL_PROVIDER_FAILURES = new Set([
  "failed",
  "cancelled",
  "expired",
]);

export type ContingencyReserveResolutionAction =
  | "none"
  | "waiting"
  | "settled"
  | "refunded"
  | "attention_required";

export interface ResolveContingencyReserveInput {
  settlementId: string;
  corridorId: string;
  recipientWallet: string;
  providerStatus: string;
  sourceLegStatus: string | null;
  destinationLegStatus: string | null;
}

export interface ContingencyReserveResolutionResult {
  settlementId: string;
  action: ContingencyReserveResolutionAction;
  reserveStatus: "funded" | "settled" | "refunded" | null;
  reason:
    | "no_reserve"
    | "provider_pending"
    | "provider_completed"
    | "provider_failed_before_payment"
    | "provider_failed_after_payment"
    | "fallback_not_ready"
    | "reserve_expired_after_payment"
    | "already_finalized";
  signature: string | null;
}

export interface ContingencyReserveResolver {
  execute(
    input: ResolveContingencyReserveInput,
  ): Promise<ContingencyReserveResolutionResult>;
}

export interface ResolveSolanaContingencyReserveOptions {
  repository: SolanaContingencyReserveRepository;
  connection: Pick<
    Connection,
    | "getLatestBlockhash"
    | "getAccountInfo"
    | "sendRawTransaction"
    | "confirmTransaction"
  >;
  programId: PublicKey;
  destinationMint: PublicKey;
  feePayer: SolanaTransactionAuthoritySigner;
  attestationAuthority: SolanaTransactionAuthoritySigner;
  liquidityAuthority: SolanaTransactionAuthoritySigner;
  now?: () => Date;
}

function alreadyFinalizedResult(
  reserve: SolanaContingencyReserve,
): ContingencyReserveResolutionResult {
  if (reserve.status === "funded") {
    throw new Error(
      `Contingency reserve ${reserve.settlementId} is not finalized`,
    );
  }

  return {
    settlementId: reserve.settlementId,
    action: reserve.status,
    reserveStatus: reserve.status,
    reason: "already_finalized",
    signature:
      reserve.settleSignature ?? reserve.refundSignature,
  };
}

export class ResolveSolanaContingencyReserveService
  implements ContingencyReserveResolver
{
  private readonly now: () => Date;

  constructor(
    private readonly options: ResolveSolanaContingencyReserveOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async signAndSend(
    transaction: Transaction,
    lifetime: {
      blockhash: string;
      lastValidBlockHeight: number;
    },
  ): Promise<string> {
    const signers = [
      this.options.feePayer,
      this.options.attestationAuthority,
    ].filter(
      (signer, index, all) =>
        all.findIndex((candidate) =>
          candidate.publicKey.equals(signer.publicKey)
        ) === index,
    );

    for (const signer of signers) {
      await signer.signTransaction(transaction);
    }

    if (!transaction.verifySignatures(true)) {
      throw new Error(
        "Contingency reserve resolution is missing a required signature",
      );
    }

    const signature =
      await this.options.connection.sendRawTransaction(
        transaction.serialize(),
        {
          maxRetries: 3,
          preflightCommitment: "confirmed",
        },
      );

    const confirmation =
      await this.options.connection.confirmTransaction(
        {
          signature,
          blockhash: lifetime.blockhash,
          lastValidBlockHeight:
            lifetime.lastValidBlockHeight,
        },
        "confirmed",
      );

    if (confirmation.value.err !== null) {
      throw new Error(
        `Contingency reserve resolution failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    }

    return signature;
  }

  private async refund(
    input: ResolveContingencyReserveInput,
    reserve: SolanaContingencyReserve,
    reason:
      | "provider_completed"
      | "provider_failed_before_payment",
  ): Promise<ContingencyReserveResolutionResult> {
    const lifetime =
      await this.options.connection.getLatestBlockhash(
        "confirmed",
      );
    const built = buildRefundContingencyReserveTransaction({
      backendSettlementId: input.settlementId,
      corridorId: input.corridorId,
      feePayer: this.options.feePayer.publicKey,
      destinationMint: this.options.destinationMint,
      attestationAuthority:
        this.options.attestationAuthority.publicKey,
      liquidityAuthority:
        this.options.liquidityAuthority.publicKey,
      programId: this.options.programId,
      recentBlockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    });
    const signature = await this.signAndSend(
      built.transaction,
      lifetime,
    );
    const stored = await this.options.repository.markRefunded({
      settlementId: input.settlementId,
      expectedVersion: reserve.version,
      signature,
    });

    return {
      settlementId: input.settlementId,
      action: "refunded",
      reserveStatus: stored.status,
      reason,
      signature,
    };
  }

  private async settle(
    input: ResolveContingencyReserveInput,
    reserve: SolanaContingencyReserve,
  ): Promise<ContingencyReserveResolutionResult> {
    const lifetime =
      await this.options.connection.getLatestBlockhash(
        "confirmed",
      );
    const built = buildSettleContingencyReserveTransaction({
      backendSettlementId: input.settlementId,
      corridorId: input.corridorId,
      recipientWallet: input.recipientWallet,
      feePayer: this.options.feePayer.publicKey,
      destinationMint: this.options.destinationMint,
      attestationAuthority:
        this.options.attestationAuthority.publicKey,
      liquidityAuthority:
        this.options.liquidityAuthority.publicKey,
      programId: this.options.programId,
      recentBlockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    });
    const signature = await this.signAndSend(
      built.transaction,
      lifetime,
    );
    const stored = await this.options.repository.markSettled({
      settlementId: input.settlementId,
      expectedVersion: reserve.version,
      signature,
    });

    return {
      settlementId: input.settlementId,
      action: "settled",
      reserveStatus: stored.status,
      reason: "provider_failed_after_payment",
      signature,
    };
  }

  async execute(
    input: ResolveContingencyReserveInput,
  ): Promise<ContingencyReserveResolutionResult> {
    const reserve = await this.options.repository.find(
      input.settlementId,
    );

    if (!reserve) {
      return {
        settlementId: input.settlementId,
        action: "none",
        reserveStatus: null,
        reason: "no_reserve",
        signature: null,
      };
    }

    if (reserve.status !== "funded") {
      return alreadyFinalizedResult(reserve);
    }

    const derived = deriveContingencyReserveAddresses({
      backendSettlementId: input.settlementId,
      corridorId: input.corridorId,
      destinationMint: this.options.destinationMint,
      liquidityAuthority:
        this.options.liquidityAuthority.publicKey,
      programId: this.options.programId,
    });

    if (
      reserve.reservePda
        !== derived.addresses.reserve.toBase58()
      || reserve.vaultPda
        !== derived.addresses.vault.toBase58()
    ) {
      throw new Error(
        `Stored contingency reserve for ${input.settlementId} does not match its derived addresses`,
      );
    }

    const reserveAccount =
      await this.options.connection.getAccountInfo(
        derived.addresses.reserve,
        "confirmed",
      );

    if (
      !reserveAccount
      || !reserveAccount.owner.equals(this.options.programId)
    ) {
      throw new Error(
        `Funded contingency reserve ${reserve.reservePda} is missing on-chain`,
      );
    }

    if (
      input.providerStatus === "completed"
      && input.sourceLegStatus === "completed"
      && input.destinationLegStatus === "completed"
    ) {
      return this.refund(input, reserve, "provider_completed");
    }

    if (!TERMINAL_PROVIDER_FAILURES.has(input.providerStatus)) {
      return {
        settlementId: input.settlementId,
        action: "waiting",
        reserveStatus: reserve.status,
        reason: "provider_pending",
        signature: null,
      };
    }

    if (input.destinationLegStatus === "completed") {
      throw new Error(
        "Terminal OZAV failure conflicts with a completed destination leg",
      );
    }

    if (input.sourceLegStatus !== "completed") {
      return this.refund(
        input,
        reserve,
        "provider_failed_before_payment",
      );
    }

    const now = this.now();
    if (now.getTime() < reserve.fallbackAfter.getTime()) {
      return {
        settlementId: input.settlementId,
        action: "waiting",
        reserveStatus: reserve.status,
        reason: "fallback_not_ready",
        signature: null,
      };
    }

    if (now.getTime() >= reserve.expiresAt.getTime()) {
      return {
        settlementId: input.settlementId,
        action: "attention_required",
        reserveStatus: reserve.status,
        reason: "reserve_expired_after_payment",
        signature: null,
      };
    }

    return this.settle(input, reserve);
  }
}
