import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  deriveAssociatedTokenAddress,
  type SolanaTransactionAuthoritySigner,
} from "../providers/peragus-solana-transaction.js";

const DEFAULT_MINIMUM_SOL_LAMPORTS = 10_000_000;
const DEFAULT_MAX_SOURCE_AMOUNT = 500_000_000n;

export interface DemoWalletFundingResult {
  wallet: string;
  sourceTokenAccount: string;
  sourceBalance: string;
  solLamports: number;
  funded: boolean;
  signature: string | null;
}

export interface DemoWalletFunder {
  ensureFunded(input: {
    wallet: string;
    sourceAmount: string;
  }): Promise<DemoWalletFundingResult>;
}

function createAssociatedTokenInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  associatedToken: PublicKey,
) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      {
        pubkey: associatedToken,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: TOKEN_2022_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    // CreateIdempotent. This stays safe if another request creates the ATA.
    data: Buffer.from([1]),
  });
}

function createMintToInstruction(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
) {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0); // SPL Token MintTo
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      {
        pubkey: destination,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: authority,
        isSigner: true,
        isWritable: false,
      },
    ],
    data,
  });
}

/** Funds only the disposable assets needed by the interactive Devnet demo. */
export class FundDevnetDemoWalletService
  implements DemoWalletFunder
{
  private readonly inFlight = new Map<
    string,
    Promise<DemoWalletFundingResult>
  >();

  constructor(
    private readonly options: {
      connection: Pick<
        Connection,
        | "getAccountInfo"
        | "getBalance"
        | "getLatestBlockhash"
        | "getTokenAccountBalance"
        | "sendRawTransaction"
        | "confirmTransaction"
      >;
      sourceMint: PublicKey;
      fundingAuthority: SolanaTransactionAuthoritySigner;
      minimumSolLamports?: number;
      maximumSourceAmount?: bigint;
    },
  ) {}

  async ensureFunded(input: {
    wallet: string;
    sourceAmount: string;
  }): Promise<DemoWalletFundingResult> {
    const wallet = new PublicKey(input.wallet);
    const key = wallet.toBase58();
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const operation = this.fund(
      wallet,
      input.sourceAmount,
    );
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fund(
    wallet: PublicKey,
    sourceAmount: string,
  ): Promise<DemoWalletFundingResult> {
    const requested = BigInt(sourceAmount);
    const maximum =
      this.options.maximumSourceAmount
      ?? DEFAULT_MAX_SOURCE_AMOUNT;
    if (requested <= 0n || requested > maximum) {
      throw new Error(
        "Demo source amount exceeds the funding limit",
      );
    }

    const authority =
      this.options.fundingAuthority.publicKey;
    const tokenAccount = deriveAssociatedTokenAddress(
      wallet,
      this.options.sourceMint,
    );
    const minimumSolLamports =
      this.options.minimumSolLamports
      ?? DEFAULT_MINIMUM_SOL_LAMPORTS;
    const [accountInfo, currentSol] = await Promise.all([
      this.options.connection.getAccountInfo(
        tokenAccount,
        "confirmed",
      ),
      this.options.connection.getBalance(
        wallet,
        "confirmed",
      ),
    ]);
    const currentTokens = accountInfo
      ? BigInt((
          await this.options.connection
            .getTokenAccountBalance(
              tokenAccount,
              "confirmed",
            )
        ).value.amount)
      : 0n;
    const tokenDeficit = requested > currentTokens
      ? requested - currentTokens
      : 0n;
    const solDeficit = Math.max(
      0,
      minimumSolLamports - currentSol,
    );

    const transaction = new Transaction();
    if (!accountInfo) {
      transaction.add(createAssociatedTokenInstruction(
        authority,
        wallet,
        this.options.sourceMint,
        tokenAccount,
      ));
    }
    if (tokenDeficit > 0n) {
      transaction.add(createMintToInstruction(
        this.options.sourceMint,
        tokenAccount,
        authority,
        tokenDeficit,
      ));
    }
    if (solDeficit > 0) {
      transaction.add(SystemProgram.transfer({
        fromPubkey: authority,
        toPubkey: wallet,
        lamports: solDeficit,
      }));
    }

    if (transaction.instructions.length === 0) {
      return {
        wallet: wallet.toBase58(),
        sourceTokenAccount: tokenAccount.toBase58(),
        sourceBalance: currentTokens.toString(),
        solLamports: currentSol,
        funded: false,
        signature: null,
      };
    }

    const latest =
      await this.options.connection.getLatestBlockhash(
        "confirmed",
      );
    transaction.feePayer = authority;
    transaction.recentBlockhash = latest.blockhash;
    await this.options.fundingAuthority
      .signTransaction(transaction);
    const signature =
      await this.options.connection.sendRawTransaction(
        transaction.serialize(),
      );
    const confirmation =
      await this.options.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight:
            latest.lastValidBlockHeight,
        },
        "confirmed",
      );
    if (confirmation.value.err) {
      throw new Error(
        "Devnet demo wallet funding failed",
      );
    }

    return {
      wallet: wallet.toBase58(),
      sourceTokenAccount: tokenAccount.toBase58(),
      sourceBalance: (currentTokens + tokenDeficit)
        .toString(),
      solLamports: currentSol + solDeficit,
      funded: true,
      signature,
    };
  }
}
