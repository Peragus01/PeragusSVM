import { createHash } from "node:crypto";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const CONFIG_SEED = Buffer.from("config");
const CORRIDOR_SEED = Buffer.from("corridor");
const SETTLEMENT_SEED = Buffer.from("settlement");

const CREATE_SETTLEMENT_DISCRIMINATOR = Buffer.from([
  109, 119, 255, 55, 76, 73, 106, 126,
]);

const EXECUTE_SETTLEMENT_DISCRIMINATOR = Buffer.from([
  237, 120, 82, 62, 224, 193, 147, 137,
]);

const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MAX = 9_223_372_036_854_775_807n;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32_PATTERN = /^[0-9a-f]{64}$/i;

type PublicKeyInput = PublicKey | string;
type IntegerInput = bigint | string;

export interface PeragusTokenAccounts {
  payerSource?: PublicKeyInput;
  liquiditySource?: PublicKeyInput;
  liquidityDestination?: PublicKeyInput;
  recipientDestination?: PublicKeyInput;
}

export interface BuildPeragusAtomicSettlementInput {
  backendSettlementId: string;
  corridorId: string;
  payerWallet: PublicKeyInput;
  recipientWallet: PublicKeyInput;
  sourceAmount: IntegerInput;
  destinationAmount: IntegerInput;
  expiresAt: Date | string;
  sourceMint: PublicKeyInput;
  destinationMint: PublicKeyInput;
  attestationAuthority: PublicKeyInput;
  liquidityAuthority: PublicKeyInput;
  programId: PublicKeyInput;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  tokenAccounts?: PeragusTokenAccounts;
}

export interface PeragusAtomicSettlementAddresses {
  config: PublicKey;
  corridor: PublicKey;
  settlement: PublicKey;
  payerSource: PublicKey;
  liquiditySource: PublicKey;
  liquidityDestination: PublicKey;
  recipientDestination: PublicKey;
}

export interface PeragusAtomicSettlementTransaction {
  transaction: Transaction;
  settlementId: Buffer;
  settlementIdHex: string;
  messageHash: string;
  addresses: PeragusAtomicSettlementAddresses;
  authorities: {
    attestation: PublicKey;
    liquidity: PublicKey;
  };
}

export interface SolanaTransactionAuthoritySigner {
  readonly publicKey: PublicKey;

  signTransaction(transaction: Transaction): Promise<void>;
}

export interface PartiallySignedPeragusTransaction {
  transactionBase64: string;
  messageHash: string;
  settlementIdHex: string;
  settlementPda: string;
  corridorPda: string;
  configPda: string;
  feePayer: string;
  requiredExternalSigner: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Adapter intended only for local development and automated tests.
 * Production signers can implement SolanaTransactionAuthoritySigner
 * through an HSM, KMS, or another isolated signing service.
 */
export class LocalKeypairAuthoritySigner
  implements SolanaTransactionAuthoritySigner
{
  readonly publicKey: PublicKey;

  constructor(private readonly keypair: Keypair) {
    this.publicKey = keypair.publicKey;
  }

  async signTransaction(
    transaction: Transaction,
  ): Promise<void> {
    transaction.partialSign(this.keypair);
  }
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

function parsePositiveU64(
  value: IntegerInput,
  field: string,
): bigint {
  let parsed: bigint;

  try {
    parsed = typeof value === "bigint"
      ? value
      : BigInt(value);
  } catch {
    throw new Error(`${field} must be an integer`);
  }

  if (parsed <= 0n || parsed > U64_MAX) {
    throw new Error(`${field} must be a positive u64`);
  }

  return parsed;
}

function parseExpiry(
  value: Date | string,
  now: Date,
): bigint {
  const expiresAt = value instanceof Date
    ? value
    : new Date(value);

  const expiresAtMilliseconds = expiresAt.getTime();

  if (!Number.isFinite(expiresAtMilliseconds)) {
    throw new Error("expiresAt must be a valid date");
  }

  const expiresAtSeconds = BigInt(
    Math.floor(expiresAtMilliseconds / 1_000),
  );

  if (expiresAtSeconds > I64_MAX) {
    throw new Error("expiresAt must fit in a signed 64-bit integer");
  }

  if (
    expiresAtSeconds
    <= BigInt(Math.floor(now.getTime() / 1_000))
  ) {
    throw new Error("expiresAt must be in the future");
  }

  return expiresAtSeconds;
}

function writeU64(value: bigint): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64LE(value);
  return encoded;
}

function writeI64(value: bigint): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigInt64LE(value);
  return encoded;
}

export function derivePeragusSettlementId(
  backendSettlementId: string,
): Buffer {
  if (!UUID_PATTERN.test(backendSettlementId)) {
    throw new Error(
      "backendSettlementId must be a canonical UUID",
    );
  }

  return createHash("sha256")
    .update("peragus:settlement:v1\0", "utf8")
    .update(backendSettlementId.toLowerCase(), "utf8")
    .digest();
}

export function decodeCorridorId(
  corridorId: string,
): Buffer {
  if (!HEX_32_PATTERN.test(corridorId)) {
    throw new Error(
      "corridorId must contain exactly 32 hexadecimal bytes",
    );
  }

  return Buffer.from(corridorId, "hex");
}

export function deriveAssociatedTokenAddress(
  owner: PublicKeyInput,
  mint: PublicKeyInput,
): PublicKey {
  const ownerPublicKey = toPublicKey(owner, "owner");
  const mintPublicKey = toPublicKey(mint, "mint");

  return PublicKey.findProgramAddressSync(
    [
      ownerPublicKey.toBuffer(),
      TOKEN_2022_PROGRAM_ID.toBuffer(),
      mintPublicKey.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function derivePeragusAddresses(input: {
  backendSettlementId: string;
  corridorId: string;
  payerWallet: PublicKeyInput;
  recipientWallet: PublicKeyInput;
  sourceMint: PublicKeyInput;
  destinationMint: PublicKeyInput;
  liquidityAuthority: PublicKeyInput;
  programId: PublicKeyInput;
  tokenAccounts?: PeragusTokenAccounts;
}): {
  settlementId: Buffer;
  addresses: PeragusAtomicSettlementAddresses;
} {
  const programId = toPublicKey(input.programId, "programId");
  const payer = toPublicKey(input.payerWallet, "payerWallet");
  const recipient = toPublicKey(
    input.recipientWallet,
    "recipientWallet",
  );
  const sourceMint = toPublicKey(
    input.sourceMint,
    "sourceMint",
  );
  const destinationMint = toPublicKey(
    input.destinationMint,
    "destinationMint",
  );
  const liquidityAuthority = toPublicKey(
    input.liquidityAuthority,
    "liquidityAuthority",
  );
  const corridorId = decodeCorridorId(input.corridorId);
  const settlementId = derivePeragusSettlementId(
    input.backendSettlementId,
  );

  const [config] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    programId,
  );
  const [corridor] = PublicKey.findProgramAddressSync(
    [CORRIDOR_SEED, corridorId],
    programId,
  );
  const [settlement] = PublicKey.findProgramAddressSync(
    [SETTLEMENT_SEED, settlementId],
    programId,
  );

  const tokenAccounts = input.tokenAccounts ?? {};

  return {
    settlementId,
    addresses: {
      config,
      corridor,
      settlement,
      payerSource: tokenAccounts.payerSource
        ? toPublicKey(
            tokenAccounts.payerSource,
            "tokenAccounts.payerSource",
          )
        : deriveAssociatedTokenAddress(payer, sourceMint),
      liquiditySource: tokenAccounts.liquiditySource
        ? toPublicKey(
            tokenAccounts.liquiditySource,
            "tokenAccounts.liquiditySource",
          )
        : deriveAssociatedTokenAddress(
            liquidityAuthority,
            sourceMint,
          ),
      liquidityDestination:
        tokenAccounts.liquidityDestination
          ? toPublicKey(
              tokenAccounts.liquidityDestination,
              "tokenAccounts.liquidityDestination",
            )
          : deriveAssociatedTokenAddress(
              liquidityAuthority,
              destinationMint,
            ),
      recipientDestination:
        tokenAccounts.recipientDestination
          ? toPublicKey(
              tokenAccounts.recipientDestination,
              "tokenAccounts.recipientDestination",
            )
          : deriveAssociatedTokenAddress(
              recipient,
              destinationMint,
            ),
    },
  };
}

export function buildPeragusAtomicSettlementTransaction(
  input: BuildPeragusAtomicSettlementInput,
  now: Date = new Date(),
): PeragusAtomicSettlementTransaction {
  const programId = toPublicKey(input.programId, "programId");
  const payer = toPublicKey(input.payerWallet, "payerWallet");
  const recipient = toPublicKey(
    input.recipientWallet,
    "recipientWallet",
  );
  const sourceMint = toPublicKey(
    input.sourceMint,
    "sourceMint",
  );
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

  if (sourceMint.equals(destinationMint)) {
    throw new Error(
      "sourceMint and destinationMint must be different",
    );
  }

  if (
    !Number.isSafeInteger(input.lastValidBlockHeight)
    || input.lastValidBlockHeight < 0
  ) {
    throw new Error(
      "lastValidBlockHeight must be a non-negative safe integer",
    );
  }

  const sourceAmount = parsePositiveU64(
    input.sourceAmount,
    "sourceAmount",
  );
  const destinationAmount = parsePositiveU64(
    input.destinationAmount,
    "destinationAmount",
  );
  const expiresAt = parseExpiry(input.expiresAt, now);

  const { settlementId, addresses } =
    derivePeragusAddresses({
      backendSettlementId: input.backendSettlementId,
      corridorId: input.corridorId,
      payerWallet: payer,
      recipientWallet: recipient,
      sourceMint,
      destinationMint,
      liquidityAuthority,
      programId,
      ...(input.tokenAccounts
        ? { tokenAccounts: input.tokenAccounts }
        : {}),
    });

  const createData = Buffer.concat([
    CREATE_SETTLEMENT_DISCRIMINATOR,
    settlementId,
    writeU64(sourceAmount),
    writeU64(destinationAmount),
    writeI64(expiresAt),
    sourceMint.toBuffer(),
    destinationMint.toBuffer(),
    recipient.toBuffer(),
    liquidityAuthority.toBuffer(),
  ]);

  const createInstruction = new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: addresses.config,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: attestationAuthority,
        isSigner: true,
        isWritable: false,
      },
      {
        pubkey: addresses.corridor,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: payer,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: addresses.settlement,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: createData,
  });

  const executeInstruction = new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: addresses.config,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: addresses.settlement,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: addresses.corridor,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: payer,
        isSigner: true,
        isWritable: false,
      },
      {
        pubkey: liquidityAuthority,
        isSigner: true,
        isWritable: false,
      },
      {
        pubkey: sourceMint,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: destinationMint,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: addresses.payerSource,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: addresses.liquiditySource,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: addresses.liquidityDestination,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: addresses.recipientDestination,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: TOKEN_2022_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: EXECUTE_SETTLEMENT_DISCRIMINATOR,
  });

  const transaction = new Transaction({
    feePayer: payer,
    blockhash: input.recentBlockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  }).add(createInstruction, executeInstruction);

  const messageHash = createHash("sha256")
    .update(transaction.serializeMessage())
    .digest("hex");

  return {
    transaction,
    settlementId,
    settlementIdHex: settlementId.toString("hex"),
    messageHash,
    addresses,
    authorities: {
      attestation: attestationAuthority,
      liquidity: liquidityAuthority,
    },
  };
}

export async function partiallySignPeragusTransaction(
  prepared: PeragusAtomicSettlementTransaction,
  input: {
    payerWallet: PublicKeyInput;
    attestationAuthority: SolanaTransactionAuthoritySigner;
    liquidityAuthority: SolanaTransactionAuthoritySigner;
  },
): Promise<PartiallySignedPeragusTransaction> {
  const payer = toPublicKey(input.payerWallet, "payerWallet");
  const feePayer = prepared.transaction.feePayer;

  if (!feePayer || !feePayer.equals(payer)) {
    throw new Error(
      "payerWallet must match the transaction fee payer",
    );
  }

  if (
    !input.attestationAuthority.publicKey.equals(
      prepared.authorities.attestation,
    )
  ) {
    throw new Error(
      "attestationAuthority does not match the prepared transaction",
    );
  }

  if (
    !input.liquidityAuthority.publicKey.equals(
      prepared.authorities.liquidity,
    )
  ) {
    throw new Error(
      "liquidityAuthority does not match the prepared transaction",
    );
  }

  const requiredSignerKeys = new Set(
    prepared.transaction
      .compileMessage()
      .accountKeys
      .slice(
        0,
        prepared.transaction.compileMessage().header
          .numRequiredSignatures,
      )
      .map((key) => key.toBase58()),
  );

  for (const [name, authority] of [
    ["attestationAuthority", input.attestationAuthority],
    ["liquidityAuthority", input.liquidityAuthority],
  ] as const) {
    if (!requiredSignerKeys.has(authority.publicKey.toBase58())) {
      throw new Error(
        `${name} is not a required signer of the transaction`,
      );
    }
  }

  const authorities = new Map<
    string,
    SolanaTransactionAuthoritySigner
  >();

  authorities.set(
    input.attestationAuthority.publicKey.toBase58(),
    input.attestationAuthority,
  );
  authorities.set(
    input.liquidityAuthority.publicKey.toBase58(),
    input.liquidityAuthority,
  );

  for (const authority of authorities.values()) {
    await authority.signTransaction(prepared.transaction);
  }

  for (const authority of authorities.values()) {
    const authoritySignature =
      prepared.transaction.signatures.find(
        ({ publicKey }) =>
          publicKey.equals(authority.publicKey),
      );

    if (!authoritySignature?.signature) {
      throw new Error(
        `missing Peragus signature for ${authority.publicKey.toBase58()}`,
      );
    }
  }

  const payerSignature = prepared.transaction.signatures.find(
    ({ publicKey }) => publicKey.equals(payer),
  );

  if (!payerSignature || payerSignature.signature !== null) {
    throw new Error(
      "payer signature must remain external to the Peragus backend",
    );
  }

  if (!prepared.transaction.verifySignatures(false)) {
    throw new Error(
      "a Peragus authority produced an invalid transaction signature",
    );
  }

  const currentMessageHash = createHash("sha256")
    .update(prepared.transaction.serializeMessage())
    .digest("hex");

  if (currentMessageHash !== prepared.messageHash) {
    throw new Error(
      "transaction message changed while collecting Peragus signatures",
    );
  }

  const transactionBase64 = prepared.transaction
    .serialize({
      requireAllSignatures: false,
      verifySignatures: true,
    })
    .toString("base64");

  return {
    transactionBase64,
    messageHash: prepared.messageHash,
    settlementIdHex: prepared.settlementIdHex,
    settlementPda: prepared.addresses.settlement.toBase58(),
    corridorPda: prepared.addresses.corridor.toBase58(),
    configPda: prepared.addresses.config.toBase58(),
    feePayer: payer.toBase58(),
    requiredExternalSigner: payer.toBase58(),
    recentBlockhash:
      prepared.transaction.recentBlockhash!,
    lastValidBlockHeight:
      prepared.transaction.lastValidBlockHeight!,
  };
}
