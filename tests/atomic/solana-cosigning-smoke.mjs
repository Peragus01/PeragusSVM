import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { buildApp } from "../../app/backend/dist/app.js";
import { ConfirmSolanaSettlementService } from "../../app/backend/dist/application/confirm-solana-settlement.js";
import { PrepareSolanaSettlementService } from "../../app/backend/dist/application/prepare-solana-settlement.js";
import { loadLocalSolanaAuthority } from "../../app/backend/dist/providers/local-solana-authority.js";

const DEFAULT_PROGRAM_ID =
  "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w";
const UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const CONFIRM_OPTIONS = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
  skipPreflight: false,
  maxRetries: 5,
};
const TOKEN_DECIMALS = 6;
const SOURCE_BALANCE = 100_000_000n;
const AMOUNT_IN = 25_000_000n;
const AMOUNT_OUT = 37_500n;

function requireLocalRpcUrl(value) {
  const parsed = new URL(value);
  const localHosts = new Set([
    "127.0.0.1",
    "localhost",
    "[::1]",
  ]);

  if (
    parsed.protocol !== "http:"
    || !localHosts.has(parsed.hostname)
  ) {
    throw new Error(
      "This smoke test only accepts a local HTTP Solana RPC URL",
    );
  }

  return value;
}

function loadKeypair(filePath, label) {
  let value;

  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }

  if (
    !Array.isArray(value)
    || value.length !== 64
    || value.some((item) =>
      !Number.isInteger(item)
      || item < 0
      || item > 255
    )
  ) {
    throw new Error(
      `${label} must contain a 64-byte Solana keypair array`,
    );
  }

  return Keypair.fromSecretKey(Uint8Array.from(value));
}

function anchorDiscriminator(name) {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function initializeConfigInstruction({
  programId,
  programData,
  admin,
  config,
  attestationAuthority,
}) {
  return new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: admin,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: programId,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programData,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: config,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.concat([
      anchorDiscriminator("initialize_config"),
      attestationAuthority.toBuffer(),
    ]),
  });
}

function createCorridorInstruction({
  programId,
  admin,
  config,
  sourceMint,
  destinationMint,
  corridor,
  corridorId,
  liquidityAuthority,
}) {
  return new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: admin,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: config,
        isSigner: false,
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
        pubkey: corridor,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.concat([
      anchorDiscriminator("create_corridor"),
      corridorId,
      liquidityAuthority.toBuffer(),
    ]),
  });
}

async function ensureFunded(connection, key) {
  const minimum = 5 * LAMPORTS_PER_SOL;
  const current = await connection.getBalance(key, "confirmed");

  if (current >= minimum) {
    return;
  }

  const signature = await connection.requestAirdrop(
    key,
    10 * LAMPORTS_PER_SOL,
  );

  await connection.confirmTransaction(signature, "confirmed");
}

async function initializeConfig({
  connection,
  programId,
  admin,
  attestationAuthority,
}) {
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  );
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    UPGRADEABLE_LOADER_ID,
  );
  const existing = await connection.getAccountInfo(
    config,
    "confirmed",
  );

  if (existing) {
    assert(
      existing.data.length >= 72,
      "Existing config account is malformed",
    );

    const configuredAuthority = new PublicKey(
      existing.data.subarray(40, 72),
    );

    assert.equal(
      configuredAuthority.toBase58(),
      attestationAuthority.toBase58(),
      "Existing config uses a different attestation authority",
    );

    return config;
  }

  const instruction = initializeConfigInstruction({
    programId,
    programData,
    admin: admin.publicKey,
    config,
    attestationAuthority,
  });

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(instruction),
    [admin],
    CONFIRM_OPTIONS,
  );

  return config;
}

async function createTestMint(
  connection,
  payer,
  mintAuthority,
) {
  return createMint(
    connection,
    payer,
    mintAuthority,
    null,
    TOKEN_DECIMALS,
    Keypair.generate(),
    CONFIRM_OPTIONS,
    TOKEN_2022_PROGRAM_ID,
  );
}

async function createTokenAccount(
  connection,
  payer,
  mint,
  owner,
) {
  return getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner,
    false,
    "confirmed",
    CONFIRM_OPTIONS,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

async function tokenBalance(connection, address) {
  return (
    await getAccount(
      connection,
      address,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    )
  ).amount;
}

function createSettlementRepository(settlement) {
  return {
    async createOrGet(candidate) {
      return {
        settlement: candidate,
        created: true,
      };
    },

    async findById(id) {
      return id === settlement.id ? settlement : null;
    },

    async findByRequestId(requestId) {
      return requestId === settlement.requestId
        ? settlement
        : null;
    },

    async updateStatus() {
      throw new Error(
        "Status updates are outside this smoke test",
      );
    },
  };
}

function createSolanaStateRepositories(settlement) {
  let savedPda;
  let createSignature;
  let executeSignature;

  return {
    preparations: {
      async savePrepared(input) {
        if (!savedPda) {
          savedPda = input.settlementPda;

          return {
            settlementPda: savedPda,
            saved: true,
          };
        }

        if (savedPda !== input.settlementPda) {
          throw new Error(
            "The prepared settlement PDA changed unexpectedly",
          );
        }

        return {
          settlementPda: savedPda,
          saved: false,
        };
      },
    },
    confirmations: {
      async findBySettlementId(id) {
        if (id !== settlement.id) {
          return null;
        }

        return {
          settlementId: settlement.id,
          status: settlement.status,
          version: settlement.version,
          settlementPda: savedPda ?? null,
          createSignature: createSignature ?? null,
          executeSignature: executeSignature ?? null,
        };
      },

      async confirmSettled(input) {
        if (
          settlement.status === "settled"
          && savedPda === input.settlementPda
          && createSignature === input.signature
          && executeSignature === input.signature
        ) {
          return {
            settlementId: settlement.id,
            status: settlement.status,
            version: settlement.version,
            settlementPda: savedPda,
            createSignature,
            executeSignature,
            saved: false,
          };
        }

        assert.equal(settlement.status, "tokenized");
        assert.equal(
          settlement.version,
          input.expectedVersion,
        );
        assert.equal(savedPda, input.settlementPda);

        settlement.status = "settled";
        settlement.version += 2;
        settlement.updatedAt = new Date();
        createSignature = input.signature;
        executeSignature = input.signature;

        return {
          settlementId: settlement.id,
          status: settlement.status,
          version: settlement.version,
          settlementPda: savedPda,
          createSignature,
          executeSignature,
          saved: true,
        };
      },
    },
  };
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "This local smoke test cannot run with NODE_ENV=production",
    );
  }

  const authoritiesDirectory =
    process.env.PERAGUS_LOCAL_AUTHORITIES_DIR
    ?? join(
      homedir(),
      ".local",
      "share",
      "peragus-local-tests",
      "authorities",
    );
  const adminPath =
    process.env.PERAGUS_LOCAL_ADMIN_KEYPAIR
    ?? join(
      homedir(),
      ".local",
      "share",
      "peragus-local-tests",
      "admin-keypair.json",
    );
  const attestationPath = join(
    authoritiesDirectory,
    "attestation-authority.json",
  );
  const liquidityPath = join(
    authoritiesDirectory,
    "liquidity-authority.json",
  );
  const acquirerPath = join(
    authoritiesDirectory,
    "acquirer-payer.json",
  );
  const recipientPath = join(
    authoritiesDirectory,
    "recipient.json",
  );
  const rpcUrl = requireLocalRpcUrl(
    process.env.SOLANA_RPC_URL
    ?? "http://127.0.0.1:18899",
  );
  const programId = new PublicKey(
    process.env.SOLANA_PROGRAM_ID
    ?? DEFAULT_PROGRAM_ID,
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const admin = loadKeypair(adminPath, "admin keypair");
  const liquidity = loadKeypair(
    liquidityPath,
    "liquidity authority keypair",
  );
  const acquirer = loadKeypair(
    acquirerPath,
    "acquirer payer keypair",
  );
  const recipient = loadKeypair(
    recipientPath,
    "recipient keypair",
  );
  const attestationAuthority = loadLocalSolanaAuthority(
    attestationPath,
    "attestation authority keypair",
  );
  const liquidityAuthority = loadLocalSolanaAuthority(
    liquidityPath,
    "liquidity authority keypair",
  );

  const validatorVersion = await connection.getVersion();
  assert(
    validatorVersion["solana-core"],
    "Local validator did not return its version",
  );

  const program = await connection.getAccountInfo(
    programId,
    "confirmed",
  );
  assert(program?.executable, "Peragus program is not deployed");

  await ensureFunded(connection, admin.publicKey);
  await ensureFunded(connection, acquirer.publicKey);

  const config = await initializeConfig({
    connection,
    programId,
    admin,
    attestationAuthority:
      attestationAuthority.publicKey,
  });

  const sourceMint = await createTestMint(
    connection,
    acquirer,
    acquirer.publicKey,
  );
  const destinationMint = await createTestMint(
    connection,
    acquirer,
    liquidity.publicKey,
  );
  const corridorId = randomBytes(32);
  const [corridor] = PublicKey.findProgramAddressSync(
    [Buffer.from("corridor"), corridorId],
    programId,
  );

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createCorridorInstruction({
        programId,
        admin: admin.publicKey,
        config,
        sourceMint,
        destinationMint,
        corridor,
        corridorId,
        liquidityAuthority: liquidity.publicKey,
      }),
    ),
    [admin],
    CONFIRM_OPTIONS,
  );

  const payerSource = await createTokenAccount(
    connection,
    acquirer,
    sourceMint,
    acquirer.publicKey,
  );
  const liquiditySource = await createTokenAccount(
    connection,
    acquirer,
    sourceMint,
    liquidity.publicKey,
  );
  const liquidityDestination = await createTokenAccount(
    connection,
    acquirer,
    destinationMint,
    liquidity.publicKey,
  );
  const recipientDestination = await createTokenAccount(
    connection,
    acquirer,
    destinationMint,
    recipient.publicKey,
  );

  await mintTo(
    connection,
    acquirer,
    sourceMint,
    payerSource.address,
    acquirer,
    SOURCE_BALANCE,
    [],
    CONFIRM_OPTIONS,
    TOKEN_2022_PROGRAM_ID,
  );
  await mintTo(
    connection,
    acquirer,
    destinationMint,
    liquidityDestination.address,
    liquidity,
    AMOUNT_OUT,
    [],
    CONFIRM_OPTIONS,
    TOKEN_2022_PROGRAM_ID,
  );

  const before = {
    payerSource: await tokenBalance(
      connection,
      payerSource.address,
    ),
    liquiditySource: await tokenBalance(
      connection,
      liquiditySource.address,
    ),
    liquidityDestination: await tokenBalance(
      connection,
      liquidityDestination.address,
    ),
    recipientDestination: await tokenBalance(
      connection,
      recipientDestination.address,
    ),
  };
  const timestamp = new Date();
  const expiresAt = new Date(timestamp.getTime() + 10 * 60_000);
  const requestPayload = {
    requestId: `solana-cosigning-smoke-${Date.now()}`,
    corridorId: corridorId.toString("hex"),
    payerWallet: acquirer.publicKey.toBase58(),
    recipientWallet: recipient.publicKey.toBase58(),
    sourceAmount: AMOUNT_IN.toString(),
    destinationAmount: AMOUNT_OUT.toString(),
    expiresAt: expiresAt.toISOString(),
  };
  const settlement = {
    id: randomUUID(),
    requestId: requestPayload.requestId,
    requestPayloadHash: createHash("sha256")
      .update(JSON.stringify(requestPayload))
      .digest("hex"),
    requestPayload,
    corridorId: requestPayload.corridorId,
    payerWallet: requestPayload.payerWallet,
    recipientWallet: requestPayload.recipientWallet,
    sourceAmount: requestPayload.sourceAmount,
    destinationAmount: requestPayload.destinationAmount,
    expiresAt,
    status: "tokenized",
    version: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const settlementRepository =
    createSettlementRepository(settlement);
  const solanaState =
    createSolanaStateRepositories(settlement);
  const preparer = new PrepareSolanaSettlementService({
    settlements: settlementRepository,
    preparations: solanaState.preparations,
    connection,
    programId: programId.toBase58(),
    sourceMint: sourceMint.toBase58(),
    destinationMint: destinationMint.toBase58(),
    attestationAuthority,
    liquidityAuthority,
  });
  const confirmer = new ConfirmSolanaSettlementService({
    settlements: settlementRepository,
    confirmations: solanaState.confirmations,
    connection,
    programId,
    sourceMint,
    destinationMint,
    attestationAuthority:
      attestationAuthority.publicKey,
    liquidityAuthority:
      liquidityAuthority.publicKey,
  });
  const app = await buildApp({
    settlementRepository,
    solanaSettlementPreparer: preparer,
    solanaSettlementConfirmer: confirmer,
    now: () => timestamp,
  });

  try {
    const response = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${settlement.id}/solana/prepare`,
    });
    const body = response.json();

    assert.equal(
      response.statusCode,
      200,
      `Preparation failed: ${JSON.stringify(body)}`,
    );
    assert.equal(
      response.headers["cache-control"],
      "no-store",
    );
    assert.equal(
      body.data.required_external_signer,
      acquirer.publicKey.toBase58(),
    );
    assert.equal(
      body.data.fee_payer,
      acquirer.publicKey.toBase58(),
    );
    assert.equal(
      body.data.config_pda,
      config.toBase58(),
    );
    assert.equal(
      body.data.corridor_pda,
      corridor.toBase58(),
    );
    assert.equal(body.meta.broadcast_by, "acquirer");

    const transaction = Transaction.from(
      Buffer.from(body.data.transaction_base64, "base64"),
    );
    const messageHash = createHash("sha256")
      .update(transaction.serializeMessage())
      .digest("hex");
    assert.equal(messageHash, body.data.message_hash);

    const missingSigners = transaction.signatures
      .filter(({ signature }) => signature === null)
      .map(({ publicKey }) => publicKey.toBase58());
    assert.deepEqual(
      missingSigners,
      [acquirer.publicKey.toBase58()],
      "Only the acquirer signature may be missing",
    );

    transaction.partialSign(acquirer);
    assert(
      transaction.signatures.every(
        ({ signature }) => signature !== null,
      ),
      "The transaction is not fully signed",
    );

    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 5,
      },
    );

    await connection.confirmTransaction(
      {
        signature,
        blockhash: body.data.recent_blockhash,
        lastValidBlockHeight:
          body.data.last_valid_block_height,
      },
      "confirmed",
    );

    const confirmationResponse = await app.inject({
      method: "POST",
      url:
        `/v1/settlements/${settlement.id}/solana/confirm`,
      payload: {
        signature,
      },
    });
    const confirmationBody = confirmationResponse.json();

    assert.equal(
      confirmationResponse.statusCode,
      200,
      `Confirmation failed: ${JSON.stringify(confirmationBody)}`,
    );
    assert.equal(confirmationBody.data.status, "settled");
    assert.equal(confirmationBody.data.signature, signature);
    assert.equal(
      confirmationBody.meta.verified_on_chain,
      true,
    );

    const after = {
      payerSource: await tokenBalance(
        connection,
        payerSource.address,
      ),
      liquiditySource: await tokenBalance(
        connection,
        liquiditySource.address,
      ),
      liquidityDestination: await tokenBalance(
        connection,
        liquidityDestination.address,
      ),
      recipientDestination: await tokenBalance(
        connection,
        recipientDestination.address,
      ),
    };

    assert.equal(
      after.payerSource,
      before.payerSource - AMOUNT_IN,
    );
    assert.equal(
      after.liquiditySource,
      before.liquiditySource + AMOUNT_IN,
    );
    assert.equal(
      after.liquidityDestination,
      before.liquidityDestination - AMOUNT_OUT,
    );
    assert.equal(
      after.recipientDestination,
      before.recipientDestination + AMOUNT_OUT,
    );

    const settlementAccount = await connection.getAccountInfo(
      new PublicKey(body.data.settlement_pda),
      "confirmed",
    );
    assert(settlementAccount, "Settlement PDA was not created");
    assert.equal(
      settlementAccount.owner.toBase58(),
      programId.toBase58(),
    );

    console.log("COASSINATURA SOLANA LOCAL: OK");
    console.table([
      {
        settlement_id: settlement.id,
        settlement_pda: body.data.settlement_pda,
        assinatura_peragus: true,
        assinatura_adquirente: true,
        status_backend: confirmationBody.data.status,
        transacao_confirmada: signature,
        payer_source_antes: before.payerSource.toString(),
        payer_source_depois: after.payerSource.toString(),
        recipient_antes:
          before.recipientDestination.toString(),
        recipient_depois:
          after.recipientDestination.toString(),
      },
    ]);
    console.log(
      "A API preparou e a Peragus coassinou; o adquirente assinou e transmitiu.",
    );
    console.log(
      "O backend verificou a transacao no RPC antes de registrar settled.",
    );
    console.log(
      "Nenhuma chave privada foi enviada pela API ou exibida no log.",
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(
    "FALHA NO SMOKE TEST DE COASSINATURA:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
