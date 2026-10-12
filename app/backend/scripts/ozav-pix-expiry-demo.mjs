import https from "node:https";

import {
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import { ConfirmSolanaSettlementService } from "../dist/application/confirm-solana-settlement.js";
import { CreateSettlementService } from "../dist/application/create-settlement.js";
import { EnsureSolanaContingencyReserveService } from "../dist/application/ensure-solana-contingency-reserve.js";
import { ImportOzavOfframpEventsService } from "../dist/application/import-ozav-offramp-events.js";
import { ImportOzavOnrampEventsService } from "../dist/application/import-ozav-onramp-events.js";
import { InitiateOzavOfframpService } from "../dist/application/initiate-ozav-offramp.js";
import { InitiateOzavOnrampService } from "../dist/application/initiate-ozav-onramp.js";
import { PrepareSolanaSettlementService } from "../dist/application/prepare-solana-settlement.js";
import { ReconcileOzavOfframpService } from "../dist/application/reconcile-ozav-offramp.js";
import { ReconcileOzavOnrampService } from "../dist/application/reconcile-ozav-onramp.js";
import { ResolveSolanaContingencyReserveService } from "../dist/application/resolve-solana-contingency-reserve.js";
import { TransitionSettlementService } from "../dist/application/transition-settlement.js";
import { getEnv } from "../dist/config/env.js";
import { createDatabasePool } from "../dist/database/pool.js";
import { loadLocalSolanaAuthority } from "../dist/providers/local-solana-authority.js";
import { OzavClient } from "../dist/providers/ozav-client.js";
import { deriveAssociatedTokenAddress } from "../dist/providers/peragus-solana-transaction.js";
import { PostgresOzavOfframpIntentRepository } from "../dist/repositories/postgres-ozav-offramp-intent-repository.js";
import { PostgresOzavOnrampIntentRepository } from "../dist/repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresOzavOnrampRepository } from "../dist/repositories/postgres-ozav-onramp-repository.js";
import { PostgresSettlementRepository } from "../dist/repositories/postgres-settlement-repository.js";
import { PostgresSolanaContingencyReserveRepository } from "../dist/repositories/solana-contingency-reserve-repository.js";
import { PostgresSolanaSettlementConfirmationRepository } from "../dist/repositories/solana-settlement-confirmation-repository.js";
import { PostgresSolanaSettlementPreparationRepository } from "../dist/repositories/solana-settlement-preparation-repository.js";

const DEFAULT_CORRIDOR_ID =
  "0c992c054ef741839bd769ad2790f1c4aa08150ac6b4465c763448fdd5fa70d4";
const DEFAULT_RECIPIENT =
  "6nTrnDfZ6UWKJAFvXiPwD6Z6TecAKqy3HPEeCe76a71o";
const RECORDING_WINDOW_SECONDS = 120;
const PROVIDER_GRACE_SECONDS = 300;
const SUCCESS_GRACE_SECONDS = 120;
const OFFRAMP_GRACE_SECONDS = 180;

const terminalProviderStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required for the demo`);
  }
  return value;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo",
  }).format(value);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(
    0,
    Math.ceil(milliseconds / 1_000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function explorer(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function assertDemoEnvironment(env) {
  if (
    env.NODE_ENV === "production"
    && !env.PERAGUS_SANDBOX_DEMO_ENABLED
  ) {
    throw new Error("The Pix expiry demo is disabled in production");
  }
  if (!env.OZAV_ONRAMP_WRITES_ENABLED) {
    throw new Error(
      "OZAV_ONRAMP_WRITES_ENABLED must be true",
    );
  }
  if (!env.SOLANA_CONTINGENCY_RESERVE_ENABLED) {
    throw new Error(
      "SOLANA_CONTINGENCY_RESERVE_ENABLED must be true",
    );
  }
  if (!env.SOLANA_RPC_URL.toLowerCase().includes("devnet")) {
    throw new Error(
      "The Pix expiry demo requires a Solana Devnet RPC",
    );
  }
}

function simulateTransfer(apiKey, transferId) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "developers.ozav.io",
      port: 443,
      path: `/v2/transfers/${encodeURIComponent(transferId)}/simulate`,
      method: "POST",
      family: 4,
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
        "Content-Length": 0,
      },
    }, (response) => {
      const chunks = [];
      let size = 0;

      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          request.destroy(
            new Error("OZAV simulate response is too large"),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => {
        request.destroy(
          new Error("OZAV simulate response was interrupted"),
        );
      });
      response.on("end", () => {
        clearTimeout(deadline);
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;

        if (raw.length) {
          try {
            body = JSON.parse(raw);
          } catch {
            reject(new Error("OZAV simulate returned invalid JSON"));
            return;
          }
        }

        resolve({
          statusCode: response.statusCode ?? 0,
          body,
        });
      });
    });

    const deadline = setTimeout(() => {
      request.destroy(new Error("OZAV simulate timed out"));
    }, 90_000);

    request.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end();
  });
}

function providerErrorCode(body) {
  if (!body || typeof body !== "object") {
    return null;
  }
  const error = body.error;
  if (!error || typeof error !== "object") {
    return null;
  }
  return typeof error.code === "string"
    ? error.code
    : null;
}

function createContext() {
  const env = getEnv();
  assertDemoEnvironment(env);

  const pool = createDatabasePool(
    required(env.DATABASE_URL, "DATABASE_URL"),
    env.DATABASE_SSL,
  );
  const settlements = new PostgresSettlementRepository(pool);
  const intents =
    new PostgresOzavOnrampIntentRepository(pool);
  const onramps = new PostgresOzavOnrampRepository(pool);
  const reserves =
    new PostgresSolanaContingencyReserveRepository(pool);
  const connection = new Connection(
    env.SOLANA_RPC_URL,
    "confirmed",
  );
  const programId = new PublicKey(env.SOLANA_PROGRAM_ID);
  const destinationMint = new PublicKey(
    required(
      env.SOLANA_DESTINATION_MINT,
      "SOLANA_DESTINATION_MINT",
    ),
  );
  const sourceMint = env.SOLANA_SOURCE_MINT
    ? new PublicKey(env.SOLANA_SOURCE_MINT)
    : null;
  const feePayer = loadLocalSolanaAuthority(
    required(
      env.SOLANA_FEE_PAYER_KEYPAIR_PATH,
      "SOLANA_FEE_PAYER_KEYPAIR_PATH",
    ),
    "SOLANA_FEE_PAYER_KEYPAIR_PATH",
  );
  const attestationAuthority = loadLocalSolanaAuthority(
    required(
      env.SOLANA_ATTESTATION_KEYPAIR_PATH,
      "SOLANA_ATTESTATION_KEYPAIR_PATH",
    ),
    "SOLANA_ATTESTATION_KEYPAIR_PATH",
  );
  const liquidityAuthority = loadLocalSolanaAuthority(
    required(
      env.SOLANA_LIQUIDITY_KEYPAIR_PATH,
      "SOLANA_LIQUIDITY_KEYPAIR_PATH",
    ),
    "SOLANA_LIQUIDITY_KEYPAIR_PATH",
  );
  const client = new OzavClient({
    apiKey: required(env.OZAV_API_KEY, "OZAV_API_KEY"),
  });

  const reserveGate =
    new EnsureSolanaContingencyReserveService({
      repository: reserves,
      connection,
      programId,
      destinationMint,
      feePayer,
      attestationAuthority,
      liquidityAuthority,
      fallbackDelaySeconds:
        env.SOLANA_CONTINGENCY_FALLBACK_SECONDS,
    });
  const reserveResolver =
    new ResolveSolanaContingencyReserveService({
      repository: reserves,
      connection,
      programId,
      destinationMint,
      feePayer,
      attestationAuthority,
      liquidityAuthority,
    });
  const importer = new ImportOzavOnrampEventsService({
    client,
    repository: onramps,
    settlements,
  });
  const reconciler = new ReconcileOzavOnrampService({
    importer,
    ozavRepository: onramps,
    settlements,
    transitioner: new TransitionSettlementService(settlements),
    contingencyReserveResolver: reserveResolver,
  });

  return {
    env,
    pool,
    settlements,
    intents,
    onramps,
    reserves,
    connection,
    programId,
    sourceMint,
    destinationMint,
    feePayer,
    attestationAuthority,
    liquidityAuthority,
    client,
    reserveGate,
    reconciler,
  };
}

async function createDemoOnramp(context, requestPrefix) {
  const {
    env,
    settlements,
    intents,
    onramps,
    reserves,
    feePayer,
    client,
    reserveGate,
    reconciler,
  } = context;
  const corridorId =
    process.env.PERAGUS_DEMO_CORRIDOR_ID
    ?? DEFAULT_CORRIDOR_ID;
  const recipient =
    process.env.PERAGUS_DEMO_RECIPIENT
    ?? DEFAULT_RECIPIENT;
  const sourceAmount = (
    500n * (10n ** BigInt(env.OZAV_SOURCE_DECIMALS))
  ).toString();
  const reserveExpiresAt = new Date(
    Date.now() + 2 * 60 * 60 * 1_000,
  );

  const created = await new CreateSettlementService(
    settlements,
  ).execute({
    requestId: `${requestPrefix}-${Date.now()}`,
    corridorId,
    payerWallet: feePayer.publicKey.toBase58(),
    recipientWallet: recipient,
    sourceAmount,
    destinationAmount: "89550000",
    expiresAt: reserveExpiresAt.toISOString(),
  });

  const initiation = await new InitiateOzavOnrampService({
    client,
    intents,
    onramps,
    settlements,
    customerId: required(
      env.OZAV_CUSTOMER_ID,
      "OZAV_CUSTOMER_ID",
    ),
    walletId: required(
      env.OZAV_WALLET_ID,
      "OZAV_WALLET_ID",
    ),
    sourceDecimals: env.OZAV_SOURCE_DECIMALS,
    spreadBps: env.OZAV_SPREAD_BPS,
    minimumSourceAmountBrl:
      env.OZAV_MIN_SOURCE_AMOUNT_BRL,
    contingencyReserve: reserveGate,
  }).execute(created.settlement.id);

  const reconciliation = await reconciler.execute(
    created.settlement.id,
  );
  const [intent, reserve] = await Promise.all([
    intents.find(created.settlement.id),
    reserves.find(created.settlement.id),
  ]);
  const pixExpiresAt = intent?.paymentInstructions?.expiresAt;

  if (!pixExpiresAt || !reserve) {
    throw new Error(
      "The integrated flow did not persist Pix and reserve data",
    );
  }
  if (pixExpiresAt.getTime() >= reserve.expiresAt.getTime()) {
    throw new Error(
      "Unsafe timing: the reserve does not outlive the Pix",
    );
  }
  if (
    reconciliation.settlementStatus !== "awaiting_pix"
    || reserve.status !== "funded"
  ) {
    throw new Error(
      "The integrated flow did not reach awaiting_pix with a funded reserve",
    );
  }

  return {
    created,
    initiation,
    reconciliation,
    intent,
    reserve,
    pixExpiresAt,
  };
}

async function prepare(context) {
  const {
    created,
    initiation,
    reconciliation,
    reserve,
    pixExpiresAt,
  } = await createDemoOnramp(
    context,
    "peragus-pix-expiry-demo",
  );

  const watchAt = new Date(
    pixExpiresAt.getTime()
    - RECORDING_WINDOW_SECONDS * 1_000,
  );

  console.log("\nPIX SANDBOX PREPARADO: OK");
  console.table([{
    settlement_id: created.settlement.id,
    settlement_status: reconciliation.settlementStatus,
    transfer_id: initiation.transferId,
    quote_usdt: initiation.quotedTargetAmountUsdt,
    pix_expira_em: formatDate(pixExpiresAt),
    reserva_expira_em: formatDate(reserve.expiresAt),
    qr_antes_da_reserva:
      pixExpiresAt.getTime() < reserve.expiresAt.getTime(),
  }]);
  console.log("RESERVA DEVNET:", explorer(reserve.createSignature));
  console.log(
    "\nInicie a gravação e execute o watch em:",
    formatDate(watchAt),
  );
  console.log("\nCOMANDO PARA O WATCH:");
  console.log(
    `npm run demo:pix-expiry:watch -- ${created.settlement.id}`,
  );
  console.log(
    "\nNão simule o pagamento dessa transferência na OZAV.",
  );
  console.log(
    "Nenhuma chave privada ou conteúdo do QR foi exibido.",
  );
}

async function success(context) {
  const {
    created,
    initiation,
    reserve: initialReserve,
    pixExpiresAt,
  } = await createDemoOnramp(
    context,
    "peragus-pix-success-demo",
  );
  const settlementId = created.settlement.id;

  console.log("\nCAMINHO FELIZ PREPARADO: OK");
  console.table([{
    settlement_id: settlementId,
    transfer_id: initiation.transferId,
    settlement_status: "awaiting_pix",
    reserve_status: initialReserve.status,
    quote_usdt: initiation.quotedTargetAmountUsdt,
    pix_expira_em: formatDate(pixExpiresAt),
  }]);
  console.log(
    "RESERVA DEVNET:",
    explorer(initialReserve.createSignature),
  );
  console.log(
    "Simulando o pagamento do Pix exclusivamente no sandbox OZAV...",
  );

  let simulation;
  try {
    simulation = await simulateTransfer(
      required(context.env.OZAV_API_KEY, "OZAV_API_KEY"),
      initiation.transferId,
    );
  } catch (error) {
    const observed = await context.client.getTransfer(
      initiation.transferId,
    );
    if (observed.status === "awaiting_payment") {
      throw error;
    }
    simulation = { statusCode: 0, body: null };
  }

  if (
    simulation.statusCode !== 0
    && (
      simulation.statusCode < 200
      || simulation.statusCode >= 300
    )
  ) {
    const observed = await context.client.getTransfer(
      initiation.transferId,
    );
    const progressed = observed.status !== "awaiting_payment";

    if (!(simulation.statusCode === 409 && progressed)) {
      const code = providerErrorCode(simulation.body);
      throw new Error(
        `OZAV simulate failed with HTTP ${simulation.statusCode}${
          code ? ` (${code})` : ""
        }`,
      );
    }
  }

  const deadline = Date.now() + SUCCESS_GRACE_SECONDS * 1_000;
  let transfer = await context.client.getTransfer(
    initiation.transferId,
  );

  while (
    transfer.status !== "completed"
    && !terminalProviderStatuses.has(transfer.status)
    && Date.now() < deadline
  ) {
    console.log(
      `OZAV informa ${transfer.status}; aguardando conclusão...`,
    );
    await delay(2_000);
    transfer = await context.client.getTransfer(
      initiation.transferId,
    );
  }

  if (transfer.status !== "completed") {
    throw new Error(
      `OZAV did not complete the sandbox transfer: ${transfer.status}`,
    );
  }

  const reconciliation = await context.reconciler.execute(
    settlementId,
  );
  const [finalSettlement, finalReserve] = await Promise.all([
    context.settlements.findById(settlementId),
    context.reserves.find(settlementId),
  ]);

  if (
    transfer.sourceLegStatus !== "completed"
    || transfer.destinationLegStatus !== "completed"
    || reconciliation.providerStatus !== "completed"
    || finalSettlement?.status !== "tokenized"
    || finalReserve?.status !== "refunded"
    || !finalReserve.refundSignature
    || reconciliation.contingencyReserveResolution?.action
      !== "refunded"
    || reconciliation.contingencyReserveResolution?.reason
      !== "provider_completed"
  ) {
    throw new Error(
      "The sandbox payment did not finish with a tokenized settlement and refunded reserve",
    );
  }

  console.log("\nPIX PAGO + TOKENIZAÇÃO + RESERVA DEVOLVIDA: OK");
  console.table([{
    settlement_id: settlementId,
    transfer_id: initiation.transferId,
    provider_status: transfer.status,
    source_leg: transfer.sourceLegStatus,
    destination_leg: transfer.destinationLegStatus,
    settlement_status: finalSettlement.status,
    reserve_status: finalReserve.status,
    reserve_action:
      reconciliation.contingencyReserveResolution.action,
    reserve_reason:
      reconciliation.contingencyReserveResolution.reason,
  }]);
  console.log(
    "RESERVA DEVNET:",
    explorer(finalReserve.createSignature),
  );
  console.log(
    "REFUND DEVNET:",
    explorer(finalReserve.refundSignature),
  );
  console.log(
    "O pagamento foi simulado somente no sandbox; nenhuma chave ou conteúdo do QR foi exibido.",
  );
}

async function readTokenBalance(connection, owner, mint) {
  const address = deriveAssociatedTokenAddress(owner, mint);
  const account = await connection.getAccountInfo(
    address,
    "confirmed",
  );

  if (!account) {
    throw new Error(
      `Required Token-2022 account is missing: ${address.toBase58()}`,
    );
  }

  const balance = await connection.getTokenAccountBalance(
    address,
    "confirmed",
  );

  return {
    address: address.toBase58(),
    amount: BigInt(balance.value.amount),
  };
}

async function readAtomicBalances(context, recipient) {
  const sourceMint = context.sourceMint;

  if (!sourceMint) {
    throw new Error(
      "SOLANA_SOURCE_MINT is required for the off-ramp demo",
    );
  }

  const [
    payerSource,
    liquiditySource,
    liquidityDestination,
    recipientDestination,
  ] = await Promise.all([
    readTokenBalance(
      context.connection,
      context.feePayer.publicKey,
      sourceMint,
    ),
    readTokenBalance(
      context.connection,
      context.liquidityAuthority.publicKey,
      sourceMint,
    ),
    readTokenBalance(
      context.connection,
      context.liquidityAuthority.publicKey,
      context.destinationMint,
    ),
    readTokenBalance(
      context.connection,
      recipient,
      context.destinationMint,
    ),
  ]);

  return {
    payerSource,
    liquiditySource,
    liquidityDestination,
    recipientDestination,
  };
}

async function completeSandboxOnramp(
  context,
  settlementId,
  transferId,
) {
  let simulation;

  try {
    simulation = await simulateTransfer(
      required(context.env.OZAV_API_KEY, "OZAV_API_KEY"),
      transferId,
    );
  } catch (error) {
    const observed = await context.client.getTransfer(transferId);
    if (observed.status === "awaiting_payment") {
      throw error;
    }
    simulation = { statusCode: 0, body: null };
  }

  if (
    simulation.statusCode !== 0
    && (
      simulation.statusCode < 200
      || simulation.statusCode >= 300
    )
  ) {
    const observed = await context.client.getTransfer(transferId);
    const progressed = observed.status !== "awaiting_payment";

    if (!(simulation.statusCode === 409 && progressed)) {
      const code = providerErrorCode(simulation.body);
      throw new Error(
        `OZAV simulate failed with HTTP ${simulation.statusCode}${
          code ? ` (${code})` : ""
        }`,
      );
    }
  }

  const deadline = Date.now() + SUCCESS_GRACE_SECONDS * 1_000;
  let transfer = await context.client.getTransfer(transferId);

  while (
    transfer.status !== "completed"
    && !terminalProviderStatuses.has(transfer.status)
    && Date.now() < deadline
  ) {
    console.log(
      `On-ramp provider status: ${transfer.status}; waiting...`,
    );
    await delay(2_000);
    transfer = await context.client.getTransfer(transferId);
  }

  if (transfer.status !== "completed") {
    throw new Error(
      `The sandbox on-ramp did not complete: ${transfer.status}`,
    );
  }

  const reconciliation = await context.reconciler.execute(
    settlementId,
  );
  const [settlement, reserve] = await Promise.all([
    context.settlements.findById(settlementId),
    context.reserves.find(settlementId),
  ]);

  if (
    transfer.sourceLegStatus !== "completed"
    || transfer.destinationLegStatus !== "completed"
    || reconciliation.providerStatus !== "completed"
    || settlement?.status !== "tokenized"
    || reserve?.status !== "refunded"
    || !reserve.refundSignature
  ) {
    throw new Error(
      "The on-ramp did not reach tokenized with its reserve refunded",
    );
  }

  return { transfer, reconciliation, settlement, reserve };
}

async function advanceExistingSettlement(context, settlementId) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(settlementId)
  ) {
    throw new Error(
      "A valid settlement id is required in advance mode",
    );
  }

  const [initialSettlement, binding, initialReserve] =
    await Promise.all([
      context.settlements.findById(settlementId),
      context.onramps.findBinding(settlementId),
      context.reserves.find(settlementId),
    ]);

  if (!initialSettlement || !binding || !initialReserve) {
    throw new Error(
      `Settlement ${settlementId} is not ready. Wait until the browser shows awaiting_pix and a funded reserve.`,
    );
  }
  if (
    !new Set(["awaiting_pix", "pix_confirmed", "tokenized"])
      .has(initialSettlement.status)
  ) {
    throw new Error(
      `Settlement ${settlementId} cannot be advanced from ${initialSettlement.status}`,
    );
  }
  if (
    initialReserve.status !== "funded"
    && initialReserve.status !== "refunded"
  ) {
    throw new Error(
      `Settlement ${settlementId} has an incompatible reserve status: ${initialReserve.status}`,
    );
  }

  console.log(
    "Peragus | Advancing the existing sandbox settlement",
  );
  console.log(`Settlement: ${settlementId}`);
  const result = await completeSandboxOnramp(
    context,
    settlementId,
    binding.transferId,
  );

  console.log(
    "\nON-RAMP COMPLETE + SETTLEMENT TOKENIZED: OK",
  );
  console.table([{
    settlement_id: settlementId,
    rail_status: result.transfer.status,
    source_leg: result.transfer.sourceLegStatus,
    destination_leg: result.transfer.destinationLegStatus,
    settlement_status: result.settlement.status,
    reserve_status: result.reserve.status,
  }]);
  console.log(
    "RESERVE DEVNET:",
    explorer(result.reserve.createSignature),
  );
  console.log(
    "RESERVE REFUND DEVNET:",
    explorer(result.reserve.refundSignature),
  );
  console.log(
    "The browser-created settlement can now be signed in the Peragus control room.",
  );
}

async function executeAtomicSettlement(context, settlementId) {
  const sourceMint = context.sourceMint;

  if (!sourceMint) {
    throw new Error(
      "SOLANA_SOURCE_MINT is required for the off-ramp demo",
    );
  }

  const preparer = new PrepareSolanaSettlementService({
    settlements: context.settlements,
    preparations:
      new PostgresSolanaSettlementPreparationRepository(
        context.pool,
      ),
    connection: context.connection,
    programId: context.programId,
    sourceMint,
    destinationMint: context.destinationMint,
    attestationAuthority: context.attestationAuthority,
    liquidityAuthority: context.liquidityAuthority,
  });
  const confirmer = new ConfirmSolanaSettlementService({
    settlements: context.settlements,
    confirmations:
      new PostgresSolanaSettlementConfirmationRepository(
        context.pool,
      ),
    connection: context.connection,
    programId: context.programId,
    sourceMint,
    destinationMint: context.destinationMint,
    attestationAuthority:
      context.attestationAuthority.publicKey,
    liquidityAuthority:
      context.liquidityAuthority.publicKey,
  });

  const prepared = await preparer.execute(settlementId);
  const transaction = Transaction.from(
    Buffer.from(prepared.transactionBase64, "base64"),
  );

  await context.feePayer.signTransaction(transaction);

  if (!transaction.verifySignatures(true)) {
    throw new Error(
      "Atomic settlement is missing a required signature",
    );
  }

  const signature = await context.connection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 3,
      preflightCommitment: "confirmed",
    },
  );
  const confirmation = await context.connection.confirmTransaction(
    {
      signature,
      blockhash: prepared.recentBlockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    },
    "confirmed",
  );

  if (confirmation.value.err !== null) {
    throw new Error(
      `Atomic settlement failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  }

  const visibilityDeadline = Date.now() + 30_000;
  let visible = false;

  while (!visible && Date.now() < visibilityDeadline) {
    visible = Boolean(await context.connection.getTransaction(
      signature,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ));

    if (!visible) {
      await delay(1_000);
    }
  }

  if (!visible) {
    throw new Error(
      "Confirmed atomic settlement was not visible through the RPC",
    );
  }

  const persisted = await confirmer.execute(
    settlementId,
    signature,
  );

  if (persisted.status !== "settled") {
    throw new Error(
      "Atomic settlement was not persisted as settled",
    );
  }

  return { prepared, persisted, signature };
}

async function completeSandboxOfframp(
  context,
  settlementId,
  payoutDestinationId,
) {
  const repository =
    new PostgresOzavOfframpIntentRepository(context.pool);
  const transitioner =
    new TransitionSettlementService(context.settlements);
  const initiator = new InitiateOzavOfframpService({
    client: context.client,
    intents: repository,
    onramps: context.onramps,
    settlements: context.settlements,
    transitioner,
    customerId: required(
      context.env.OZAV_CUSTOMER_ID,
      "OZAV_CUSTOMER_ID",
    ),
    walletId: required(
      context.env.OZAV_WALLET_ID,
      "OZAV_WALLET_ID",
    ),
    spreadBps: context.env.OZAV_SPREAD_BPS,
  });
  const importer = new ImportOzavOfframpEventsService({
    client: context.client,
    repository,
    settlements: context.settlements,
  });
  const reconciler = new ReconcileOzavOfframpService({
    importer,
    repository,
    settlements: context.settlements,
    transitioner,
  });

  const initiation = await initiator.execute({
    settlementId,
    payoutDestinationId,
  });
  const deadline = Date.now() + OFFRAMP_GRACE_SECONDS * 1_000;
  let reconciliation = await reconciler.execute(settlementId);

  while (
    reconciliation.settlementStatus === "offramping"
    && Date.now() < deadline
  ) {
    console.log(
      `Off-ramp OZAV em ${reconciliation.providerStatus}; aguardando...`,
    );
    await delay(2_000);
    reconciliation = await reconciler.execute(settlementId);
  }

  if (
    reconciliation.providerStatus !== "completed"
    || reconciliation.sourceLegStatus !== "completed"
    || reconciliation.destinationLegStatus !== "completed"
    || reconciliation.settlementStatus !== "paid_out"
  ) {
    throw new Error(
      `OZAV off-ramp did not finish successfully: ${reconciliation.providerStatus}/${reconciliation.settlementStatus}`,
    );
  }

  let events = await repository.listEvents(settlementId);
  const eventDeadline = Date.now() + 30_000;

  while (
    !events.some((event) =>
      event.eventType === "transfer.completed"
    )
    && Date.now() < eventDeadline
  ) {
    await delay(1_000);
    reconciliation = await reconciler.execute(settlementId);
    events = await repository.listEvents(settlementId);
  }

  if (!events.some((event) =>
    event.eventType === "transfer.completed"
  )) {
    throw new Error(
      "OZAV completed the off-ramp without exposing transfer.completed in time",
    );
  }

  const replay = await reconciler.execute(settlementId);

  if (
    replay.settlementStatus !== "paid_out"
    || replay.transitions.length !== 0
  ) {
    throw new Error(
      "Off-ramp reconciliation was not idempotent",
    );
  }

  return { initiation, reconciliation, replay, events };
}

async function offramp(context, payoutDestinationId) {
  if (!/^ozav_pd_[A-Za-z0-9_]+$/.test(payoutDestinationId)) {
    throw new Error(
      "A valid ozav_pd_ payout destination id is required",
    );
  }
  if (!context.env.OZAV_OFFRAMP_WRITES_ENABLED) {
    throw new Error(
      "OZAV_OFFRAMP_WRITES_ENABLED must be true",
    );
  }
  if (!context.env.SOLANA_COSIGNING_ENABLED) {
    throw new Error(
      "SOLANA_COSIGNING_ENABLED must be true",
    );
  }

  const recipient = new PublicKey(
    process.env.PERAGUS_DEMO_RECIPIENT
      ?? DEFAULT_RECIPIENT,
  );
  const before = await readAtomicBalances(context, recipient);
  const sourceAmount = 500n * 1_000_000n;
  const destinationAmount = 89_550_000n;

  if (before.payerSource.amount < sourceAmount) {
    throw new Error(
      "The payer does not have 500 mBRL for the atomic demo",
    );
  }
  if (before.liquidityDestination.amount < destinationAmount) {
    throw new Error(
      "The liquidity authority does not have 89.55 USDT for the atomic demo",
    );
  }

  const preparedOnramp = await createDemoOnramp(
    context,
    "peragus-offramp-demo",
  );
  const settlementId = preparedOnramp.created.settlement.id;

  console.log("\nROUNDTRIP PREPARADO: OK");
  console.table([{
    settlement_id: settlementId,
    onramp_transfer_id: preparedOnramp.initiation.transferId,
    settlement_status: "awaiting_pix",
    reserve_status: preparedOnramp.reserve.status,
  }]);
  console.log(
    "Simulando somente o pagamento de entrada no sandbox OZAV...",
  );

  const onramp = await completeSandboxOnramp(
    context,
    settlementId,
    preparedOnramp.initiation.transferId,
  );

  console.log("ON-RAMP COMPLETO + RESERVA DEVOLVIDA: OK");

  const atomic = await executeAtomicSettlement(
    context,
    settlementId,
  );

  console.log("LIQUIDAÇÃO ATÔMICA DEVNET: OK");

  const payout = await completeSandboxOfframp(
    context,
    settlementId,
    payoutDestinationId,
  );
  const [finalSettlement, after] = await Promise.all([
    context.settlements.findById(settlementId),
    readAtomicBalances(context, recipient),
  ]);

  const deltas = {
    payerSource:
      after.payerSource.amount - before.payerSource.amount,
    liquiditySource:
      after.liquiditySource.amount
      - before.liquiditySource.amount,
    liquidityDestination:
      after.liquidityDestination.amount
      - before.liquidityDestination.amount,
    recipientDestination:
      after.recipientDestination.amount
      - before.recipientDestination.amount,
  };

  if (
    finalSettlement?.status !== "paid_out"
    || deltas.payerSource !== -sourceAmount
    || deltas.liquiditySource !== sourceAmount
    || deltas.liquidityDestination !== -destinationAmount
    || deltas.recipientDestination !== destinationAmount
  ) {
    throw new Error(
      "The final settlement or atomic Token-2022 balance deltas are invalid",
    );
  }

  console.log("\nROUNDTRIP PIX → SOLANA → PIX: OK");
  console.table([{
    settlement_id: settlementId,
    onramp_transfer_id: preparedOnramp.initiation.transferId,
    onramp_status: onramp.transfer.status,
    solana_status: atomic.persisted.status,
    offramp_transfer_id: payout.initiation.transferId,
    offramp_status: payout.reconciliation.providerStatus,
    source_leg: payout.reconciliation.sourceLegStatus,
    destination_leg:
      payout.reconciliation.destinationLegStatus,
    settlement_status: finalSettlement.status,
    eventos_persistidos: payout.events.length,
    replay_idempotente:
      payout.replay.transitions.length === 0,
  }]);
  console.table([
    {
      conta: "payer_mbrl",
      antes: before.payerSource.amount.toString(),
      depois: after.payerSource.amount.toString(),
      delta: deltas.payerSource.toString(),
    },
    {
      conta: "liquidity_mbrl",
      antes: before.liquiditySource.amount.toString(),
      depois: after.liquiditySource.amount.toString(),
      delta: deltas.liquiditySource.toString(),
    },
    {
      conta: "liquidity_usdt",
      antes: before.liquidityDestination.amount.toString(),
      depois: after.liquidityDestination.amount.toString(),
      delta: deltas.liquidityDestination.toString(),
    },
    {
      conta: "recipient_usdt",
      antes: before.recipientDestination.amount.toString(),
      depois: after.recipientDestination.amount.toString(),
      delta: deltas.recipientDestination.toString(),
    },
  ]);
  console.table(payout.events.map((event) => ({
    event_id: event.eventId,
    event_type: event.eventType,
    provider_status: event.snapshot.status,
  })));
  console.log(
    "RESERVA DEVNET:",
    explorer(onramp.reserve.createSignature),
  );
  console.log(
    "REFUND DEVNET:",
    explorer(onramp.reserve.refundSignature),
  );
  console.log(
    "SETTLEMENT DEVNET:",
    explorer(atomic.signature),
  );
  console.log(
    "O off-ramp avançou automaticamente no sandbox; nenhuma simulação de saída ou chave Pix foi exibida.",
  );
}

async function watch(context, settlementId) {
  const {
    settlements,
    intents,
    onramps,
    reserves,
    client,
    reconciler,
  } = context;
  const [settlement, intent, binding, initialReserve] =
    await Promise.all([
      settlements.findById(settlementId),
      intents.find(settlementId),
      onramps.findBinding(settlementId),
      reserves.find(settlementId),
    ]);

  if (
    !settlement
    || !intent?.paymentInstructions
    || !binding
    || !initialReserve
  ) {
    throw new Error(
      `Demo data is incomplete for settlement ${settlementId}`,
    );
  }

  const pixExpiresAt = intent.paymentInstructions.expiresAt;
  const remainingAtStart =
    pixExpiresAt.getTime() - Date.now();

  if (
    remainingAtStart
    > RECORDING_WINDOW_SECONDS * 1_000
  ) {
    const watchAt = new Date(
      pixExpiresAt.getTime()
      - RECORDING_WINDOW_SECONDS * 1_000,
    );
    console.log(
      `Ainda faltam ${formatDuration(remainingAtStart)} para o Pix expirar.`,
    );
    console.log(
      `Execute este comando novamente às ${formatDate(watchAt)}.`,
    );
    return;
  }

  console.log("Peragus | Expiração real do Pix sandbox");
  console.log(`Settlement: ${settlementId}`);
  console.log(`Transferência OZAV: ${binding.transferId}`);
  console.log(`Pix expira em: ${formatDate(pixExpiresAt)}`);
  console.log(
    `Reserva expira depois: ${formatDate(initialReserve.expiresAt)}`,
  );

  while (Date.now() < pixExpiresAt.getTime()) {
    console.log(
      `Aguardando expiração real do Pix: ${formatDuration(
        pixExpiresAt.getTime() - Date.now(),
      )}`,
    );
    await delay(
      Math.min(
        5_000,
        Math.max(250, pixExpiresAt.getTime() - Date.now()),
      ),
    );
  }

  console.log("Pix chegou ao expires_at; aguardando a OZAV confirmar...");
  const providerDeadline =
    Date.now() + PROVIDER_GRACE_SECONDS * 1_000;
  let providerTransfer = await client.getTransfer(
    binding.transferId,
  );

  while (
    !terminalProviderStatuses.has(providerTransfer.status)
    && Date.now() < providerDeadline
  ) {
    console.log(
      `OZAV ainda informa ${providerTransfer.status}; consultando novamente...`,
    );
    await delay(2_000);
    providerTransfer = await client.getTransfer(
      binding.transferId,
    );
  }

  if (!terminalProviderStatuses.has(providerTransfer.status)) {
    throw new Error(
      `OZAV did not publish a terminal status within ${PROVIDER_GRACE_SECONDS} seconds`,
    );
  }
  if (providerTransfer.status === "completed") {
    throw new Error(
      "The OZAV transfer completed instead of expiring; do not use it as the failure demo",
    );
  }

  const reconciliation = await reconciler.execute(settlementId);
  const [finalSettlement, finalReserve] = await Promise.all([
    settlements.findById(settlementId),
    reserves.find(settlementId),
  ]);

  if (
    reconciliation.providerStatus !== "expired"
    || finalSettlement?.status !== "failed"
    || finalReserve?.status !== "refunded"
    || !finalReserve.refundSignature
  ) {
    throw new Error(
      "The expired Pix did not finish with a refunded contingency reserve",
    );
  }

  console.log("\nPIX EXPIRADO + RESERVA DEVOLVIDA: OK");
  console.table([{
    settlement_id: settlementId,
    provider_status: reconciliation.providerStatus,
    source_leg: providerTransfer.sourceLegStatus,
    settlement_status: finalSettlement.status,
    reserve_status: finalReserve.status,
    reserve_action:
      reconciliation.contingencyReserveResolution?.action,
    reserve_reason:
      reconciliation.contingencyReserveResolution?.reason,
    pagamento_duplicado: "bloqueado",
  }]);
  console.log(
    "RESERVA DEVNET:",
    explorer(finalReserve.createSignature),
  );
  console.log(
    "REFUND DEVNET:",
    explorer(finalReserve.refundSignature),
  );
  console.log(
    "O Pix expirou antes da reserva e nenhum pagamento foi simulado.",
  );
}

const mode = process.argv[2];
const argument = process.argv[3];

if (!new Set([
  "prepare",
  "watch",
  "success",
  "advance",
  "offramp",
]).has(mode)) {
  throw new Error(
    "Use `prepare`, `watch <settlement-id>`, `success`, `advance <settlement-id>`, or `offramp <payout-destination-id>`",
  );
}
if (mode === "watch" && !argument) {
  throw new Error(
    "A settlement id is required in watch mode",
  );
}
if (mode === "advance" && !argument) {
  throw new Error(
    "A settlement id is required in advance mode",
  );
}
if (mode === "offramp" && !argument) {
  throw new Error(
    "A payout destination id is required in off-ramp mode",
  );
}

const context = createContext();

try {
  if (mode === "prepare") {
    await prepare(context);
  } else if (mode === "watch") {
    await watch(context, argument);
  } else if (mode === "success") {
    await success(context);
  } else if (mode === "advance") {
    await advanceExistingSettlement(context, argument);
  } else {
    await offramp(context, argument);
  }
} finally {
  await context.pool.end();
}
