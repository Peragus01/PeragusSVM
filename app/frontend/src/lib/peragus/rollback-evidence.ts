import { type Connection, type Message, PublicKey } from "@solana/web3.js";

import type { PreparedRollbackDemo } from "./api";

export interface RollbackBalanceEvidence {
  account: "payer source" | "liquidity source" | "liquidity destination" | "recipient destination";
  address: string;
  before: string;
  after: string;
  unchanged: true;
}

export interface AtomicRollbackEvidence {
  signature: string;
  slot: number;
  transactionFailed: true;
  legAReached: true;
  legBFailed: true;
  settlementPdaAbsent: true;
  balancesUnchanged: true;
  balances: RollbackBalanceEvidence[];
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const roleEntries = (
  prepared: PreparedRollbackDemo,
): Array<{
  account: RollbackBalanceEvidence["account"];
  address: string;
}> => [
  {
    account: "payer source",
    address: prepared.token_accounts.payer_source,
  },
  {
    account: "liquidity source",
    address: prepared.token_accounts.liquidity_source,
  },
  {
    account: "liquidity destination",
    address: prepared.token_accounts.liquidity_destination,
  },
  {
    account: "recipient destination",
    address: prepared.token_accounts.recipient_destination,
  },
];

export async function readAtomicRollbackEvidence(
  connection: Pick<Connection, "getTransaction" | "getAccountInfo">,
  prepared: PreparedRollbackDemo,
  signature: string,
): Promise<AtomicRollbackEvidence> {
  let transaction: Awaited<ReturnType<Connection["getTransaction"]>> = null;
  let lastRpcError: unknown = null;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      transaction = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      lastRpcError = null;
    } catch (error) {
      lastRpcError = error;
    }
    if (transaction?.meta) break;
    await wait(500);
  }

  if (!transaction?.meta) {
    const rpcMessage =
      typeof lastRpcError === "object" &&
      lastRpcError !== null &&
      "message" in lastRpcError &&
      typeof lastRpcError.message === "string"
        ? ` Last RPC response: ${lastRpcError.message}`
        : "";
    throw new Error(
      `The failed Devnet transaction is not indexed yet. Retry the evidence check shortly.${rpcMessage}`,
    );
  }

  if (transaction.meta.err === null) {
    throw new Error("Fault injection unexpectedly succeeded; rollback was not proven.");
  }

  const logs = transaction.meta.logMessages ?? [];
  const legAIndex = logs.indexOf("Program log: Leg A CPI succeeded");
  const insufficientIndex = logs.findIndex((line) => line.includes("Error: insufficient funds"));
  if (
    legAIndex < 0 ||
    insufficientIndex <= legAIndex ||
    logs.includes("Program log: Leg B CPI succeeded")
  ) {
    throw new Error("Devnet logs do not prove the expected second-leg failure.");
  }

  const message = transaction.transaction.message as Message;
  const accountKeys = message.accountKeys.map((key) => key.toBase58());
  const before = transaction.meta.preTokenBalances ?? [];
  const after = transaction.meta.postTokenBalances ?? [];
  const balances = roleEntries(prepared).map((entry) => {
    const accountIndex = accountKeys.indexOf(entry.address);
    const beforeAmount = before.find((balance) => balance.accountIndex === accountIndex)
      ?.uiTokenAmount.amount;
    const afterAmount = after.find((balance) => balance.accountIndex === accountIndex)
      ?.uiTokenAmount.amount;

    if (
      accountIndex < 0 ||
      beforeAmount === undefined ||
      afterAmount === undefined ||
      beforeAmount !== afterAmount
    ) {
      throw new Error(`Token rollback could not be verified for ${entry.account}.`);
    }

    return {
      ...entry,
      before: beforeAmount,
      after: afterAmount,
      unchanged: true as const,
    };
  });

  const settlementAccount = await connection.getAccountInfo(
    new PublicKey(prepared.settlement_pda),
    "confirmed",
  );
  if (settlementAccount) {
    throw new Error(
      "The settlement PDA exists after the failed transaction; rollback was not proven.",
    );
  }

  return {
    signature,
    slot: transaction.slot,
    transactionFailed: true,
    legAReached: true,
    legBFailed: true,
    settlementPdaAbsent: true,
    balancesUnchanged: true,
    balances,
  };
}
