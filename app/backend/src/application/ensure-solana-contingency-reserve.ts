import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import {
  buildCreateContingencyReserveTransaction,
  deriveContingencyReserveAddresses,
} from "../providers/peragus-contingency-reserve-transaction.js";
import type { SolanaTransactionAuthoritySigner } from "../providers/peragus-solana-transaction.js";
import type {
  SolanaContingencyReserve,
  SolanaContingencyReserveRepository,
} from "../repositories/solana-contingency-reserve-repository.js";

const USDT_DECIMALS = 6;
const USDT_PATTERN = /^\d+(?:\.\d{1,6})?$/;

export interface EnsureContingencyReserveInput {
  settlementId: string;
  corridorId: string;
  recipientWallet: string;
  amountUsdt: string;
  expiresAt: Date;
}

export interface EnsureContingencyReserveResult {
  settlementId: string;
  reservePda: string;
  vaultPda: string;
  amountUsdt: string;
  amountBaseUnits: string;
  fallbackAfter: Date;
  expiresAt: Date;
  createSignature: string;
  idempotentReplay: boolean;
}

export interface OzavContingencyReserveGate {
  ensureBeforePix(
    input: EnsureContingencyReserveInput,
  ): Promise<EnsureContingencyReserveResult>;
}

export interface EnsureSolanaContingencyReserveOptions {
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
  fallbackDelaySeconds: number;
  now?: () => Date;
}

function normalizeUsdt(input: string): {
  decimal: string;
  baseUnits: bigint;
} {
  if (!USDT_PATTERN.test(input)) {
    throw new Error(
      "OZAV target amount must be a positive USDT value with at most 6 decimals",
    );
  }

  const [whole = "0", fraction = ""] = input.split(".");
  const baseUnits = BigInt(whole) * 1_000_000n
    + BigInt(fraction.padEnd(USDT_DECIMALS, "0"));

  if (baseUnits <= 0n) {
    throw new Error("OZAV target amount must be greater than zero");
  }

  const normalizedWhole = baseUnits / 1_000_000n;
  const normalizedFraction = (baseUnits % 1_000_000n)
    .toString()
    .padStart(USDT_DECIMALS, "0")
    .replace(/0+$/, "");

  return {
    decimal: normalizedFraction
      ? `${normalizedWhole}.${normalizedFraction}`
      : normalizedWhole.toString(),
    baseUnits,
  };
}

function resultFromStored(
  stored: SolanaContingencyReserve,
  idempotentReplay: boolean,
): EnsureContingencyReserveResult {
  return {
    settlementId: stored.settlementId,
    reservePda: stored.reservePda,
    vaultPda: stored.vaultPda,
    amountUsdt: stored.amountUsdt,
    amountBaseUnits: stored.amountBaseUnits,
    fallbackAfter: stored.fallbackAfter,
    expiresAt: stored.expiresAt,
    createSignature: stored.createSignature,
    idempotentReplay,
  };
}

export class EnsureSolanaContingencyReserveService
  implements OzavContingencyReserveGate
{
  private readonly now: () => Date;

  constructor(
    private readonly options: EnsureSolanaContingencyReserveOptions,
  ) {
    if (
      !Number.isInteger(options.fallbackDelaySeconds)
      || options.fallbackDelaySeconds < 1
    ) {
      throw new Error(
        "fallbackDelaySeconds must be a positive integer",
      );
    }

    this.now = options.now ?? (() => new Date());
  }

  async ensureBeforePix(
    input: EnsureContingencyReserveInput,
  ): Promise<EnsureContingencyReserveResult> {
    const amount = normalizeUsdt(input.amountUsdt);
    const existing = await this.options.repository.find(
      input.settlementId,
    );

    if (existing) {
      if (
        existing.amountUsdt !== amount.decimal
        || existing.amountBaseUnits !== amount.baseUnits.toString()
        || existing.expiresAt.getTime()
          !== input.expiresAt.getTime()
      ) {
        throw new Error(
          `Settlement ${input.settlementId} already has a different contingency reserve`,
        );
      }

      return resultFromStored(existing, true);
    }

    const now = this.now();
    const fallbackAfter = new Date(
      now.getTime()
      + this.options.fallbackDelaySeconds * 1_000,
    );

    if (fallbackAfter.getTime() >= input.expiresAt.getTime()) {
      throw new Error(
        "Settlement expires before the contingency fallback window",
      );
    }

    const derived = deriveContingencyReserveAddresses({
      backendSettlementId: input.settlementId,
      corridorId: input.corridorId,
      destinationMint: this.options.destinationMint,
      liquidityAuthority:
        this.options.liquidityAuthority.publicKey,
      programId: this.options.programId,
    });

    const onchain = await this.options.connection.getAccountInfo(
      derived.addresses.reserve,
      "confirmed",
    );
    if (onchain) {
      throw new Error(
        `Contingency reserve ${derived.addresses.reserve.toBase58()} exists on-chain without a database record`,
      );
    }

    const lifetime =
      await this.options.connection.getLatestBlockhash(
        "confirmed",
      );

    const built = buildCreateContingencyReserveTransaction({
      backendSettlementId: input.settlementId,
      corridorId: input.corridorId,
      feePayer: this.options.feePayer.publicKey,
      recipient: input.recipientWallet,
      destinationMint: this.options.destinationMint,
      attestationAuthority:
        this.options.attestationAuthority.publicKey,
      liquidityAuthority:
        this.options.liquidityAuthority.publicKey,
      programId: this.options.programId,
      amount: amount.baseUnits,
      fallbackAfter,
      expiresAt: input.expiresAt,
      recentBlockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    });

    const signers = [
      this.options.feePayer,
      this.options.attestationAuthority,
      this.options.liquidityAuthority,
    ].filter(
      (signer, index, all) =>
        all.findIndex((candidate) =>
          candidate.publicKey.equals(signer.publicKey)
        ) === index,
    );

    for (const signer of signers) {
      await signer.signTransaction(built.transaction);
    }

    if (!built.transaction.verifySignatures(true)) {
      throw new Error(
        "Contingency reserve transaction is missing a required signature",
      );
    }

    const signature =
      await this.options.connection.sendRawTransaction(
        built.transaction.serialize(),
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
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        },
        "confirmed",
      );

    if (confirmation.value.err !== null) {
      throw new Error(
        `Contingency reserve transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    }

    const stored = await this.options.repository.saveFunded({
      settlementId: input.settlementId,
      reservePda: built.addresses.reserve.toBase58(),
      vaultPda: built.addresses.vault.toBase58(),
      amountUsdt: amount.decimal,
      amountBaseUnits: amount.baseUnits.toString(),
      fallbackAfter,
      expiresAt: input.expiresAt,
      createSignature: signature,
    });

    return resultFromStored(stored, false);
  }
}
