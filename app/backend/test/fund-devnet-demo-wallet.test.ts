import {
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { FundDevnetDemoWalletService } from "../src/application/fund-devnet-demo-wallet.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "../src/providers/peragus-solana-transaction.js";

describe("Devnet demo wallet funding", () => {
  it("creates the Token-2022 account, mints only the deficit, and supplies fee SOL", async () => {
    const authority = Keypair.generate();
    const wallet = Keypair.generate().publicKey;
    const sourceMint = Keypair.generate().publicKey;
    const blockhash =
      Keypair.generate().publicKey.toBase58();
    let submitted: Transaction | null = null;
    const connection = {
      getAccountInfo: vi.fn(async () => null),
      getBalance: vi.fn(async () => 0),
      getTokenAccountBalance: vi.fn(async () => {
        throw new Error("unexpected token read");
      }),
      getLatestBlockhash: vi.fn(async () => ({
        blockhash,
        lastValidBlockHeight: 123,
      })),
      sendRawTransaction: vi.fn(
        async (bytes: Buffer | Uint8Array) => {
          submitted = Transaction.from(bytes);
          return "demo-funding-signature";
        },
      ),
      confirmTransaction: vi.fn(async () => ({
        context: { slot: 1 },
        value: { err: null },
      })),
    };
    const subject = new FundDevnetDemoWalletService({
      connection,
      sourceMint,
      fundingAuthority: {
        publicKey: authority.publicKey,
        async signTransaction(transaction) {
          transaction.partialSign(authority);
        },
      },
    });

    const input = {
      wallet: wallet.toBase58(),
      sourceAmount: "500000000",
    };
    const [funded, concurrentReplay] =
      await Promise.all([
        subject.ensureFunded(input),
        subject.ensureFunded(input),
      ]);

    expect(funded).toMatchObject({
      wallet: wallet.toBase58(),
      sourceBalance: "500000000",
      solLamports: 10_000_000,
      funded: true,
      signature: "demo-funding-signature",
    });
    expect(concurrentReplay).toEqual(funded);
    expect(connection.sendRawTransaction)
      .toHaveBeenCalledTimes(1);

    expect(submitted).not.toBeNull();
    expect(
      submitted!.instructions.map((instruction) =>
        instruction.programId.toBase58()),
    ).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
  });

  it("rejects amounts above the fixed demo budget before RPC access", async () => {
    const getBalance = vi.fn();
    const subject = new FundDevnetDemoWalletService({
      connection: {
        getAccountInfo: vi.fn(),
        getBalance,
        getTokenAccountBalance: vi.fn(),
        getLatestBlockhash: vi.fn(),
        sendRawTransaction: vi.fn(),
        confirmTransaction: vi.fn(),
      },
      sourceMint: Keypair.generate().publicKey,
      fundingAuthority: {
        publicKey: Keypair.generate().publicKey,
        async signTransaction() {},
      },
    });

    await expect(subject.ensureFunded({
      wallet: Keypair.generate().publicKey.toBase58(),
      sourceAmount: "500000001",
    })).rejects.toThrow("funding limit");
    expect(getBalance).not.toHaveBeenCalled();
  });
});
