import { createHash } from "node:crypto";

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeCorridorId,
  deriveAssociatedTokenAddress,
  derivePeragusSettlementId,
  TOKEN_2022_PROGRAM_ID,
} from "./peragus-solana-transaction.js";

const CONFIG_SEED = Buffer.from("config");
const CORRIDOR_SEED = Buffer.from("corridor");
const RESERVE_SEED = Buffer.from("contingency-reserve");
const VAULT_SEED = Buffer.from("contingency-vault");

const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MAX = 9_223_372_036_854_775_807n;

type PublicKeyInput = PublicKey | string;

export interface BuildContingencyReserveTransactionInput {
  backendSettlementId: string;
  corridorId: string;
  feePayer: PublicKeyInput;
  recipient: PublicKeyInput;
  destinationMint: PublicKeyInput;
  attestationAuthority: PublicKeyInput;
  liquidityAuthority: PublicKeyInput;
  programId: PublicKeyInput;
  amount: bigint;
  fallbackAfter: Date;
  expiresAt: Date;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  liquidityDestination?: PublicKeyInput;
}

export interface ContingencyReserveAddresses {
  config: PublicKey;
  corridor: PublicKey;
  reserve: PublicKey;
  vault: PublicKey;
  liquidityDestination: PublicKey;
}

export interface BuiltContingencyReserveTransaction {
  transaction: Transaction;
  settlementId: Buffer;
  addresses: ContingencyReserveAddresses;
}

export interface BuildResolveContingencyReserveTransactionInput {
  backendSettlementId: string;
  corridorId: string;
  feePayer: PublicKeyInput;
  destinationMint: PublicKeyInput;
  attestationAuthority: PublicKeyInput;
  liquidityAuthority: PublicKeyInput;
  programId: PublicKeyInput;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  liquidityDestination?: PublicKeyInput;
}

export interface BuildSettleContingencyReserveTransactionInput
  extends BuildResolveContingencyReserveTransactionInput {
  recipientWallet: PublicKeyInput;
}

export interface BuiltResolveContingencyReserveTransaction {
  transaction: Transaction;
  addresses: ContingencyReserveAddresses & {
    recipientDestination?: PublicKey;
  };
}

function toPublicKey(
  value: PublicKeyInput,
  field: string,
): PublicKey {
  try {
    return value instanceof PublicKey
      ? value
      : new PublicKey(value);
  } catch {
    throw new Error(`${field} must be a valid Solana public key`);
  }
}

function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`, "utf8")
    .digest()
    .subarray(0, 8);
}

function assertTransactionLifetime(
  lastValidBlockHeight: number,
): void {
  if (
    !Number.isSafeInteger(lastValidBlockHeight)
    || lastValidBlockHeight < 0
  ) {
    throw new Error(
      "lastValidBlockHeight must be a non-negative safe integer",
    );
  }
}

function associatedTokenAccountInstruction(input: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  address: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.address, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    // Associated Token Account instruction 1 is CreateIdempotent.
    data: Buffer.from([1]),
  });
}

function writeU64(value: bigint): Buffer {
  if (value <= 0n || value > U64_MAX) {
    throw new Error("amount must be a positive u64");
  }

  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value);
  return data;
}

function writeI64(value: Date, field: string): Buffer {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${field} must be a valid date`);
  }

  const seconds = BigInt(Math.floor(milliseconds / 1_000));
  if (seconds < 0n || seconds > I64_MAX) {
    throw new Error(`${field} must fit in a positive i64`);
  }

  const data = Buffer.alloc(8);
  data.writeBigInt64LE(seconds);
  return data;
}

export function deriveContingencyReserveAddresses(input: {
  backendSettlementId: string;
  corridorId: string;
  destinationMint: PublicKeyInput;
  liquidityAuthority: PublicKeyInput;
  programId: PublicKeyInput;
  liquidityDestination?: PublicKeyInput;
}): {
  settlementId: Buffer;
  addresses: ContingencyReserveAddresses;
} {
  const programId = toPublicKey(input.programId, "programId");
  const destinationMint = toPublicKey(
    input.destinationMint,
    "destinationMint",
  );
  const liquidityAuthority = toPublicKey(
    input.liquidityAuthority,
    "liquidityAuthority",
  );
  const settlementId = derivePeragusSettlementId(
    input.backendSettlementId,
  );
  const corridorId = decodeCorridorId(input.corridorId);

  const [config] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    programId,
  );
  const [corridor] = PublicKey.findProgramAddressSync(
    [CORRIDOR_SEED, corridorId],
    programId,
  );
  const [reserve] = PublicKey.findProgramAddressSync(
    [RESERVE_SEED, settlementId],
    programId,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, settlementId],
    programId,
  );

  return {
    settlementId,
    addresses: {
      config,
      corridor,
      reserve,
      vault,
      liquidityDestination: input.liquidityDestination
        ? toPublicKey(
            input.liquidityDestination,
            "liquidityDestination",
          )
        : deriveAssociatedTokenAddress(
            liquidityAuthority,
            destinationMint,
          ),
    },
  };
}

export function buildCreateContingencyReserveTransaction(
  input: BuildContingencyReserveTransactionInput,
): BuiltContingencyReserveTransaction {
  const programId = toPublicKey(input.programId, "programId");
  const feePayer = toPublicKey(input.feePayer, "feePayer");
  const recipient = toPublicKey(input.recipient, "recipient");
  const destinationMint = toPublicKey(
    input.destinationMint,
    "destinationMint",
  );
  const attestationAuthority = toPublicKey(
    input.attestationAuthority,
    "attestationAuthority",
  );
  const liquidityAuthority = toPublicKey(
    input.liquidityAuthority,
    "liquidityAuthority",
  );

  assertTransactionLifetime(input.lastValidBlockHeight);

  if (input.fallbackAfter.getTime() >= input.expiresAt.getTime()) {
    throw new Error("fallbackAfter must be before expiresAt");
  }

  const { settlementId, addresses } =
    deriveContingencyReserveAddresses({
      backendSettlementId: input.backendSettlementId,
      corridorId: input.corridorId,
      destinationMint,
      liquidityAuthority,
      programId,
      ...(input.liquidityDestination
        ? { liquidityDestination: input.liquidityDestination }
        : {}),
    });

  const data = Buffer.concat([
    instructionDiscriminator("create_contingency_reserve"),
    settlementId,
    writeU64(input.amount),
    writeI64(input.fallbackAfter, "fallbackAfter"),
    writeI64(input.expiresAt, "expiresAt"),
    recipient.toBuffer(),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: addresses.config, isSigner: false, isWritable: false },
      { pubkey: attestationAuthority, isSigner: true, isWritable: false },
      { pubkey: addresses.corridor, isSigner: false, isWritable: false },
      { pubkey: feePayer, isSigner: true, isWritable: true },
      { pubkey: liquidityAuthority, isSigner: true, isWritable: false },
      { pubkey: destinationMint, isSigner: false, isWritable: false },
      {
        pubkey: addresses.liquidityDestination,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: addresses.reserve, isSigner: false, isWritable: true },
      { pubkey: addresses.vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const transaction = new Transaction({
    feePayer,
    blockhash: input.recentBlockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  }).add(instruction);

  return {
    transaction,
    settlementId,
    addresses,
  };
}


export function buildSettleContingencyReserveTransaction(
  input: BuildSettleContingencyReserveTransactionInput,
): BuiltResolveContingencyReserveTransaction {
  assertTransactionLifetime(input.lastValidBlockHeight);

  const programId = toPublicKey(input.programId, "programId");
  const feePayer = toPublicKey(input.feePayer, "feePayer");
  const destinationMint = toPublicKey(
    input.destinationMint,
    "destinationMint",
  );
  const attestationAuthority = toPublicKey(
    input.attestationAuthority,
    "attestationAuthority",
  );
  const liquidityAuthority = toPublicKey(
    input.liquidityAuthority,
    "liquidityAuthority",
  );
  const recipient = toPublicKey(
    input.recipientWallet,
    "recipientWallet",
  );
  const { addresses } = deriveContingencyReserveAddresses({
    backendSettlementId: input.backendSettlementId,
    corridorId: input.corridorId,
    destinationMint,
    liquidityAuthority,
    programId,
    ...(input.liquidityDestination
      ? { liquidityDestination: input.liquidityDestination }
      : {}),
  });
  const recipientDestination = deriveAssociatedTokenAddress(
    recipient,
    destinationMint,
  );

  const settleInstruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: addresses.config, isSigner: false, isWritable: false },
      { pubkey: attestationAuthority, isSigner: true, isWritable: false },
      { pubkey: addresses.reserve, isSigner: false, isWritable: true },
      { pubkey: addresses.corridor, isSigner: false, isWritable: false },
      { pubkey: destinationMint, isSigner: false, isWritable: false },
      { pubkey: addresses.vault, isSigner: false, isWritable: true },
      { pubkey: recipientDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: instructionDiscriminator("settle_contingency_reserve"),
  });

  const transaction = new Transaction({
    feePayer,
    blockhash: input.recentBlockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  });

  transaction.add(
    associatedTokenAccountInstruction({
      payer: feePayer,
      owner: recipient,
      mint: destinationMint,
      address: recipientDestination,
    }),
    settleInstruction,
  );

  return {
    transaction,
    addresses: {
      ...addresses,
      recipientDestination,
    },
  };
}

export function buildRefundContingencyReserveTransaction(
  input: BuildResolveContingencyReserveTransactionInput,
): BuiltResolveContingencyReserveTransaction {
  assertTransactionLifetime(input.lastValidBlockHeight);

  const programId = toPublicKey(input.programId, "programId");
  const feePayer = toPublicKey(input.feePayer, "feePayer");
  const destinationMint = toPublicKey(
    input.destinationMint,
    "destinationMint",
  );
  const attestationAuthority = toPublicKey(
    input.attestationAuthority,
    "attestationAuthority",
  );
  const liquidityAuthority = toPublicKey(
    input.liquidityAuthority,
    "liquidityAuthority",
  );
  const { addresses } = deriveContingencyReserveAddresses({
    backendSettlementId: input.backendSettlementId,
    corridorId: input.corridorId,
    destinationMint,
    liquidityAuthority,
    programId,
    ...(input.liquidityDestination
      ? { liquidityDestination: input.liquidityDestination }
      : {}),
  });

  const refundInstruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: addresses.config, isSigner: false, isWritable: false },
      { pubkey: attestationAuthority, isSigner: true, isWritable: false },
      { pubkey: addresses.reserve, isSigner: false, isWritable: true },
      { pubkey: addresses.corridor, isSigner: false, isWritable: false },
      { pubkey: liquidityAuthority, isSigner: false, isWritable: false },
      { pubkey: destinationMint, isSigner: false, isWritable: false },
      { pubkey: addresses.vault, isSigner: false, isWritable: true },
      {
        pubkey: addresses.liquidityDestination,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: instructionDiscriminator("refund_contingency_reserve"),
  });

  const transaction = new Transaction({
    feePayer,
    blockhash: input.recentBlockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  }).add(refundInstruction);

  return { transaction, addresses };
}
