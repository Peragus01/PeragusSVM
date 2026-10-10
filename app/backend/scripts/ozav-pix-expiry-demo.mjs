import https from "node:https";

import { Connection, PublicKey } from "@solana/web3.js";

import { CreateSettlementService } from "../dist/application/create-settlement.js";
import { EnsureSolanaContingencyReserveService } from "../dist/application/ensure-solana-contingency-reserve.js";
import { ImportOzavOnrampEventsService } from "../dist/application/import-ozav-onramp-events.js";
import { InitiateOzavOnrampService } from "../dist/application/initiate-ozav-onramp.js";
import { ReconcileOzavOnrampService } from "../dist/application/reconcile-ozav-onramp.js";
import { ResolveSolanaContingencyReserveService } from "../dist/application/resolve-solana-contingency-reserve.js";
import { TransitionSettlementService } from "../dist/application/transition-settlement.js";
import { getEnv } from "../dist/config/env.js";
import { createDatabasePool } from "../dist/database/pool.js";
import { loadLocalSolanaAuthority } from "../dist/providers/local-solana-authority.js";
import { OzavClient } from "../dist/providers/ozav-client.js";
import { PostgresOzavOnrampIntentRepository } from "../dist/repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresOzavOnrampRepository } from "../dist/repositories/postgres-ozav-onramp-repository.js";
import { PostgresSettlementRepository } from "../dist/repositories/postgres-settlement-repository.js";
import { PostgresSolanaContingencyReserveRepository } from "../dist/repositories/solana-contingency-reserve-repository.js";

const DEFAULT_CORRIDOR_ID =
  "0c992c054ef741839bd769ad2790f1c4aa08150ac6b4465c763448fdd5fa70d4";
const DEFAULT_RECIPIENT =
  "6nTrnDfZ6UWKJAFvXiPwD6Z6TecAKqy3HPEeCe76a71o";
const RECORDING_WINDOW_SECONDS = 120;
const PROVIDER_GRACE_SECONDS = 300;
const SUCCESS_GRACE_SECONDS = 120;

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
    throw new Error(`${name} is required for the expiry demo`);
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
  if (env.NODE_ENV === "production") {
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
    feePayer,
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
const settlementId = process.argv[3];

if (!new Set(["prepare", "watch", "success"]).has(mode)) {
  throw new Error(
    "Use `prepare`, `watch <settlement-id>`, or `success`",
  );
}
if (mode === "watch" && !settlementId) {
  throw new Error(
    "A settlement id is required in watch mode",
  );
}

const context = createContext();

try {
  if (mode === "prepare") {
    await prepare(context);
  } else if (mode === "watch") {
    await watch(context, settlementId);
  } else {
    await success(context);
  }
} finally {
  await context.pool.end();
}
