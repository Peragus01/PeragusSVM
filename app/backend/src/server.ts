import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

import { buildApp } from "./app.js";
import {
  ConfirmSolanaSettlementService,
  type SolanaSettlementConfirmer,
} from "./application/confirm-solana-settlement.js";
import {
  GetOzavOnrampService,
  type OzavOnrampReader,
} from "./application/get-ozav-onramp.js";
import {
  GetSettlementAuditService,
  type SettlementAuditReader,
} from "./application/get-settlement-audit.js";
import {
  InitiateOzavOfframpService,
  type OzavOfframpInitiator,
} from "./application/initiate-ozav-offramp.js";
import {
  PrepareSolanaSettlementService,
  type SolanaSettlementPreparer,
} from "./application/prepare-solana-settlement.js";
import { TransitionSettlementService } from "./application/transition-settlement.js";
import { getEnv } from "./config/env.js";
import { createDatabasePool } from "./database/pool.js";
import {
  createJobQueue,
  ensureSettlementQueues,
  PgBossOzavOfframpReconciliationScheduler,
  PgBossSettlementJobPublisher,
} from "./jobs/pg-boss.js";
import type { OzavOfframpReconciliationScheduler } from "./jobs/ozav-offramp-reconciliation.js";
import {
  NoopSettlementJobPublisher,
  type SettlementJobPublisher,
} from "./jobs/settlement-orchestration.js";
import { loadLocalSolanaAuthority } from "./providers/local-solana-authority.js";
import { OzavClient } from "./providers/ozav-client.js";
import { InMemorySettlementRepository } from "./repositories/in-memory-settlement-repository.js";
import { PostgresOzavOfframpIntentRepository } from "./repositories/postgres-ozav-offramp-intent-repository.js";
import { PostgresOzavOnrampIntentRepository } from "./repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresOzavOnrampRepository } from "./repositories/postgres-ozav-onramp-repository.js";
import { PostgresSettlementRepository } from "./repositories/postgres-settlement-repository.js";
import { PostgresSolanaContingencyReserveRepository } from "./repositories/solana-contingency-reserve-repository.js";
import { PostgresSolanaSettlementConfirmationRepository } from "./repositories/solana-settlement-confirmation-repository.js";
import { PostgresSolanaSettlementPreparationRepository } from "./repositories/solana-settlement-preparation-repository.js";
import type { SettlementRepository } from "./repositories/settlement-repository.js";

const env = getEnv();

let pool: Pool | undefined;
let boss: PgBoss | undefined;
let settlementRepository: SettlementRepository;
let ozavOnrampReader: OzavOnrampReader | undefined;
let settlementAuditReader:
  | SettlementAuditReader
  | undefined;
let ozavOfframpInitiator:
  | OzavOfframpInitiator
  | undefined;
let ozavOfframpReconciliationScheduler:
  | OzavOfframpReconciliationScheduler
  | undefined;
let solanaSettlementPreparer:
  | SolanaSettlementPreparer
  | undefined;
let solanaSettlementConfirmer:
  | SolanaSettlementConfirmer
  | undefined;
let settlementJobPublisher: SettlementJobPublisher =
  new NoopSettlementJobPublisher();

if (env.DATABASE_URL) {
  const databasePool = createDatabasePool(
    env.DATABASE_URL,
    env.DATABASE_SSL,
  );

  const jobQueue = createJobQueue(
    env.DATABASE_URL,
    env.DATABASE_SSL,
  );

  jobQueue.on("error", (error) => {
    console.error("PG-BOSS ERROR:", error);
  });

  try {
    await jobQueue.start();
    await ensureSettlementQueues(jobQueue);
  } catch (error) {
    await jobQueue.stop().catch(() => undefined);
    await databasePool.end().catch(() => undefined);
    throw error;
  }

  pool = databasePool;
  boss = jobQueue;
  ozavOfframpReconciliationScheduler =
    new PgBossOzavOfframpReconciliationScheduler(
      jobQueue,
      env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
      env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
    );

  settlementRepository =
    new PostgresSettlementRepository(databasePool);

  const onrampIntents =
    new PostgresOzavOnrampIntentRepository(databasePool);
  const onramps =
    new PostgresOzavOnrampRepository(databasePool);
  const offramps =
    new PostgresOzavOfframpIntentRepository(databasePool);
  const contingencyReserves =
    new PostgresSolanaContingencyReserveRepository(
      databasePool,
    );
  const solanaSettlements =
    new PostgresSolanaSettlementConfirmationRepository(
      databasePool,
    );

  ozavOnrampReader = new GetOzavOnrampService({
    settlements: settlementRepository,
    intents: onrampIntents,
    onramps,
  });

  settlementAuditReader = new GetSettlementAuditService({
    settlements: settlementRepository,
    onrampIntents,
    onramps,
    contingencyReserves,
    solanaSettlements,
    offramps,
  });

  if (env.OZAV_OFFRAMP_WRITES_ENABLED) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "OZAV sandbox off-ramp writes cannot be enabled in production",
      );
    }

    const ozavClient = new OzavClient({
      apiKey: env.OZAV_API_KEY!,
    });

    ozavOfframpInitiator =
      new InitiateOzavOfframpService({
        client: ozavClient,
        intents: offramps,
        onramps,
        settlements: settlementRepository,
        transitioner:
          new TransitionSettlementService(
            settlementRepository,
          ),
        customerId: env.OZAV_CUSTOMER_ID!,
        walletId: env.OZAV_WALLET_ID!,
        spreadBps: env.OZAV_SPREAD_BPS,
      });
  }

  if (env.SOLANA_COSIGNING_ENABLED) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "Local Solana keypair signers cannot be enabled in production; configure an HSM/KMS signer adapter",
      );
    }

    if (
      !env.SOLANA_SOURCE_MINT
      || !env.SOLANA_DESTINATION_MINT
      || !env.SOLANA_ATTESTATION_KEYPAIR_PATH
      || !env.SOLANA_LIQUIDITY_KEYPAIR_PATH
    ) {
      throw new Error(
        "Solana cosigning configuration is incomplete",
      );
    }

    const solanaConnection = new Connection(
      env.SOLANA_RPC_URL,
      "confirmed",
    );
    const solanaProgramId = new PublicKey(
      env.SOLANA_PROGRAM_ID,
    );
    const sourceMint = new PublicKey(
      env.SOLANA_SOURCE_MINT,
    );
    const destinationMint = new PublicKey(
      env.SOLANA_DESTINATION_MINT,
    );
    const attestationAuthority = loadLocalSolanaAuthority(
      env.SOLANA_ATTESTATION_KEYPAIR_PATH,
      "SOLANA_ATTESTATION_KEYPAIR_PATH",
    );
    const liquidityAuthority = loadLocalSolanaAuthority(
      env.SOLANA_LIQUIDITY_KEYPAIR_PATH,
      "SOLANA_LIQUIDITY_KEYPAIR_PATH",
    );

    solanaSettlementPreparer =
      new PrepareSolanaSettlementService({
        settlements: settlementRepository,
        preparations:
          new PostgresSolanaSettlementPreparationRepository(
            databasePool,
          ),
        connection: solanaConnection,
        programId: solanaProgramId,
        sourceMint,
        destinationMint,
        attestationAuthority,
        liquidityAuthority,
      });

    solanaSettlementConfirmer =
      new ConfirmSolanaSettlementService({
        settlements: settlementRepository,
        confirmations: solanaSettlements,
        connection: solanaConnection,
        programId: solanaProgramId,
        sourceMint,
        destinationMint,
        attestationAuthority:
          attestationAuthority.publicKey,
        liquidityAuthority:
          liquidityAuthority.publicKey,
      });
  }

  settlementJobPublisher =
    new PgBossSettlementJobPublisher(jobQueue);
} else {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is required when NODE_ENV=production",
    );
  }

  settlementRepository =
    new InMemorySettlementRepository();
}

const app = await buildApp({
  logger: {
    level: env.LOG_LEVEL,
  },
  settlementRepository,
  settlementJobPublisher,
  ozavOnrampReader,
  settlementAuditReader,
  ozavOfframpInitiator,
  ozavOfframpReconciliationScheduler,
  solanaSettlementPreparer,
  solanaSettlementConfirmer,
});

const databasePool = pool;
const jobQueue = boss;

app.addHook("onClose", async () => {
  if (jobQueue) {
    await jobQueue.stop();
  }

  if (databasePool) {
    await databasePool.end();
  }
});

if (!pool) {
  app.log.warn(
    "DATABASE_URL is not configured; using volatile in-memory storage",
  );
}

let shuttingDown = false;

async function shutdown(
  signal: NodeJS.Signals,
): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  app.log.info(
    { signal },
    "Shutting down Peragus backend",
  );

  await app.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
