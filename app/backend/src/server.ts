import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

import { buildApp } from "./app.js";
import {
  GetOzavOnrampService,
  type OzavOnrampReader,
} from "./application/get-ozav-onramp.js";
import {
  PrepareSolanaSettlementService,
  type SolanaSettlementPreparer,
} from "./application/prepare-solana-settlement.js";
import { getEnv } from "./config/env.js";
import { createDatabasePool } from "./database/pool.js";
import {
  createJobQueue,
  ensureSettlementQueues,
  PgBossSettlementJobPublisher,
} from "./jobs/pg-boss.js";
import {
  NoopSettlementJobPublisher,
  type SettlementJobPublisher,
} from "./jobs/settlement-orchestration.js";
import { loadLocalSolanaAuthority } from "./providers/local-solana-authority.js";
import { InMemorySettlementRepository } from "./repositories/in-memory-settlement-repository.js";
import { PostgresOzavOnrampIntentRepository } from "./repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresOzavOnrampRepository } from "./repositories/postgres-ozav-onramp-repository.js";
import { PostgresSettlementRepository } from "./repositories/postgres-settlement-repository.js";
import { PostgresSolanaSettlementPreparationRepository } from "./repositories/solana-settlement-preparation-repository.js";
import type { SettlementRepository } from "./repositories/settlement-repository.js";

const env = getEnv();

let pool: Pool | undefined;
let boss: PgBoss | undefined;
let settlementRepository: SettlementRepository;
let ozavOnrampReader: OzavOnrampReader | undefined;
let solanaSettlementPreparer:
  | SolanaSettlementPreparer
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

  settlementRepository =
    new PostgresSettlementRepository(databasePool);

  ozavOnrampReader = new GetOzavOnrampService({
    settlements: settlementRepository,
    intents:
      new PostgresOzavOnrampIntentRepository(databasePool),
    onramps:
      new PostgresOzavOnrampRepository(databasePool),
  });

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

    solanaSettlementPreparer =
      new PrepareSolanaSettlementService({
        settlements: settlementRepository,
        preparations:
          new PostgresSolanaSettlementPreparationRepository(
            databasePool,
          ),
        connection: new Connection(
          env.SOLANA_RPC_URL,
          "confirmed",
        ),
        programId: new PublicKey(env.SOLANA_PROGRAM_ID),
        sourceMint: new PublicKey(env.SOLANA_SOURCE_MINT),
        destinationMint: new PublicKey(
          env.SOLANA_DESTINATION_MINT,
        ),
        attestationAuthority: loadLocalSolanaAuthority(
          env.SOLANA_ATTESTATION_KEYPAIR_PATH,
          "SOLANA_ATTESTATION_KEYPAIR_PATH",
        ),
        liquidityAuthority: loadLocalSolanaAuthority(
          env.SOLANA_LIQUIDITY_KEYPAIR_PATH,
          "SOLANA_LIQUIDITY_KEYPAIR_PATH",
        ),
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
  solanaSettlementPreparer,
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
