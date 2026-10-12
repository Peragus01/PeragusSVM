import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import type { PreparedRollbackDemo } from "@/lib/peragus/api";
import { readAtomicRollbackEvidence } from "@/lib/peragus/rollback-evidence";

function fixture(changeAfter = false) {
  const payer = Keypair.generate().publicKey;
  const program = Keypair.generate().publicKey;
  const accounts = {
    payer_source: Keypair.generate().publicKey.toBase58(),
    liquidity_source: Keypair.generate().publicKey.toBase58(),
    liquidity_destination: Keypair.generate().publicKey.toBase58(),
    recipient_destination: Keypair.generate().publicKey.toBase58(),
  };
  const transaction = new Transaction({
    feePayer: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: program,
      keys: Object.values(accounts).map((address) => ({
        pubkey: new PublicKey(address),
        isSigner: false,
        isWritable: true,
      })),
      data: Buffer.from([1]),
    }),
  );
  const message = transaction.compileMessage();
  const amounts = ["500000000", "0", "10000000000", "0"];
  const tokenBalances = Object.values(accounts).map((address, position) => ({
    accountIndex: message.accountKeys.findIndex((key) => key.toBase58() === address),
    mint: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    uiTokenAmount: {
      amount: amounts[position]!,
      decimals: 6,
      uiAmount: null,
      uiAmountString: "0",
    },
  }));
  const prepared: PreparedRollbackDemo = {
    settlement_id: "b2a3b4fc-7a59-41ec-9ef6-b9b39b1400a1",
    settlement_pda: Keypair.generate().publicKey.toBase58(),
    corridor_pda: Keypair.generate().publicKey.toBase58(),
    config_pda: Keypair.generate().publicKey.toBase58(),
    transaction_base64: "AQID",
    message_hash: "ab".repeat(32),
    fee_payer: payer.toBase58(),
    required_external_signer: payer.toBase58(),
    recent_blockhash: transaction.recentBlockhash!,
    last_valid_block_height: 100,
    scenario: "second_leg_insufficient_liquidity",
    injected_destination_amount: "18446744073709551615",
    available_destination_balance: "10000000000",
    token_accounts: accounts,
  };
  const result = {
    slot: 42,
    meta: {
      err: { InstructionError: [1, { Custom: 1 }] },
      logMessages: ["Program log: Leg A CPI succeeded", "Program log: Error: insufficient funds"],
      preTokenBalances: tokenBalances,
      postTokenBalances: tokenBalances.map((balance, index) => ({
        ...balance,
        uiTokenAmount: {
          ...balance.uiTokenAmount,
          amount: changeAfter && index === 0 ? "499999999" : balance.uiTokenAmount.amount,
        },
      })),
    },
    transaction: {
      message,
      signatures: [],
    },
    version: "legacy",
  };
  const connection = {
    getTransaction: vi.fn(async () => result as never),
    getAccountInfo: vi.fn(async () => null),
  } as unknown as Pick<Connection, "getTransaction" | "getAccountInfo">;

  return { connection, prepared };
}

describe("atomic rollback evidence", () => {
  it("accepts a failed second leg only when every token balance is unchanged", async () => {
    const { connection, prepared } = fixture();

    const evidence = await readAtomicRollbackEvidence(connection, prepared, "rollback-signature");

    expect(evidence.transactionFailed).toBe(true);
    expect(evidence.legAReached).toBe(true);
    expect(evidence.legBFailed).toBe(true);
    expect(evidence.settlementPdaAbsent).toBe(true);
    expect(evidence.balances).toHaveLength(4);
    expect(evidence.balances.every((row) => row.unchanged)).toBe(true);
  });

  it("rejects evidence if any token balance changed", async () => {
    const { connection, prepared } = fixture(true);

    await expect(
      readAtomicRollbackEvidence(connection, prepared, "rollback-signature"),
    ).rejects.toThrow("Token rollback could not be verified");
  });
});
