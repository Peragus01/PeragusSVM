import { ImportOzavOnrampEventsService } from "./application/import-ozav-onramp-events.js";
import { InitiateOzavOnrampService } from "./application/initiate-ozav-onramp.js";
import { ReconcileOzavOnrampService } from "./application/reconcile-ozav-onramp.js";
import { TransitionSettlementService } from "./application/transition-settlement.js";
import { getEnv } from "./config/env.js";
import { createDatabasePool } from "./database/pool.js";
import {
  createJobQueue,
  ensureSettlementQueues,
  PgBossOzavReconciliationScheduler,
} from "./jobs/pg-boss.js";
import {
  OZAV_RECONCILIATION_QUEUE,
  OzavReconciliationJobHandler,
  shouldContinueOzavReconciliation,
  type OzavReconciliationJob,
} from "./jobs/ozav-reconciliation.js";
import {
  SETTLEMENT_ORCHESTRATION_QUEUE,
  SettlementOrchestrationHandler,
  type SettlementOrchestrationJob,
} from "./jobs/settlement-orchestration.js";
import { OzavClient } from "./providers/ozav-client.js";
import { PostgresOzavOnrampIntentRepository } from "./repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresOzavOnrampRepository } from "./repositories/postgres-ozav-onramp-repository.js";
import { PostgresSettlementRepository } from "./repositories/postgres-settlement-repository.js";

const env = getEnv();

if (!env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required to start the worker",
  );
}

if (!env.OZAV_API_KEY) {
  throw new Error(
    "OZAV_API_KEY is required to start the worker",
  );
}

if (
  env.OZAV_ONRAMP_WRITES_ENABLED
  && (!env.OZAV_CUSTOMER_ID || !env.OZAV_WALLET_ID)
) {
  throw new Error(
    "OZAV_CUSTOMER_ID and OZAV_WALLET_ID are required "
    + "when OZAV on-ramp writes are enabled",
  );
}

const pool = createDatabasePool(
  env.DATABASE_URL,
  env.DATABASE_SSL,
);

const repository =
  new PostgresSettlementRepository(pool);

const ozavRepository =
  new PostgresOzavOnrampRepository(pool);

const ozavIntentRepository =
  new PostgresOzavOnrampIntentRepository(pool);

const ozavClient = new OzavClient({
  apiKey: env.OZAV_API_KEY,
});

const ozavImporter = new ImportOzavOnrampEventsService({
  client: ozavClient,
  repository: ozavRepository,
  settlements: repository,
});

const ozavReconciler = new ReconcileOzavOnrampService({
  importer: ozavImporter,
  ozavRepository,
  settlements: repository,
  transitioner: new TransitionSettlementService(repository),
});

const ozavInitiator =
  env.OZAV_ONRAMP_WRITES_ENABLED
    ? new InitiateOzavOnrampService({
        client: ozavClient,
        intents: ozavIntentRepository,
        onramps: ozavRepository,
        settlements: repository,
        customerId: env.OZAV_CUSTOMER_ID!,
        walletId: env.OZAV_WALLET_ID!,
        sourceDecimals: env.OZAV_SOURCE_DECIMALS,
        spreadBps: env.OZAV_SPREAD_BPS,
        minimumSourceAmountBrl:
          env.OZAV_MIN_SOURCE_AMOUNT_BRL,
      })
    : undefined;

const boss = createJobQueue(
  env.DATABASE_URL,
  env.DATABASE_SSL,
);

const ozavReconciliationScheduler =
  new PgBossOzavReconciliationScheduler(
    boss,
    env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
    env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
  );

boss.on("error", (error) => {
  console.error("PG-BOSS ERROR:", error);
});

let shuttingDown = false;

async function shutdown(
  signal: NodeJS.Signals,
): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.info(
    JSON.stringify({
      event: "worker_shutdown",
      signal,
    }),
  );

  await boss.stop({
    graceful: true,
    timeout: 30_000,
  });

  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error("WORKER SHUTDOWN ERROR:", error);
      process.exitCode = 1;
    });
  });
}

try {
  await boss.start();
  await ensureSettlementQueues(boss);

  const handler =
    new SettlementOrchestrationHandler(repository);

  const ozavReconciliationHandler =
    new OzavReconciliationJobHandler(
      repository,
      ozavReconciler,
      ozavReconciliationScheduler,
    );

  await boss.work<SettlementOrchestrationJob>(
    SETTLEMENT_ORCHESTRATION_QUEUE,
    {
      pollingIntervalSeconds:
        env.JOB_POLL_INTERVAL_SECONDS,
      localConcurrency: env.JOB_CONCURRENCY,
    },
    async ([job]) => {
      if (!job) {
        throw new Error(
          "Settlement worker received an empty batch",
        );
      }

      const result = await handler.execute(job.data);
      const initiation = ozavInitiator
        ? await ozavInitiator.execute(result.settlementId)
        : {
            enabled: false as const,
          };
      const ozav = await ozavReconciler.execute(
        result.settlementId,
      );
      const nextOzavReconciliation =
        shouldContinueOzavReconciliation(ozav)
          ? await ozavReconciliationScheduler.schedule({
              settlementId: result.settlementId,
              requestId: result.requestId,
              attempt: 1,
            })
          : null;

      console.info(
        JSON.stringify({
          event: "settlement_job_processed",
          jobId: job.id,
          ...result,
          status: ozav.settlementStatus,
          ozavInitiation: initiation,
          ozav,
          nextOzavReconciliation,
        }),
      );

      return {
        ...result,
        status: ozav.settlementStatus,
        ozavInitiation: initiation,
        ozav,
        nextOzavReconciliation,
      };
    },
  );

  await boss.work<OzavReconciliationJob>(
    OZAV_RECONCILIATION_QUEUE,
    {
      pollingIntervalSeconds:
        env.JOB_POLL_INTERVAL_SECONDS,
      localConcurrency: env.JOB_CONCURRENCY,
    },
    async ([job]) => {
      if (!job) {
        throw new Error(
          "OZAV reconciliation worker received an empty batch",
        );
      }

      const result =
        await ozavReconciliationHandler.execute(job.data);

      console.info(
        JSON.stringify({
          event: "ozav_reconciliation_job_processed",
          jobId: job.id,
          ...result,
        }),
      );

      return result;
    },
  );

  console.info(
    JSON.stringify({
      event: "worker_started",
      queue: SETTLEMENT_ORCHESTRATION_QUEUE,
      concurrency: env.JOB_CONCURRENCY,
      ozavEnvironment: "test",
      ozavOnrampWritesEnabled:
        env.OZAV_ONRAMP_WRITES_ENABLED,
      ozavReconciliationQueue:
        OZAV_RECONCILIATION_QUEUE,
      ozavReconciliationIntervalSeconds:
        env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
      ozavReconciliationMaxAttempts:
        env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
    }),
  );
} catch (error) {
  console.error("WORKER STARTUP ERROR:", error);

  await boss.stop().catch(() => undefined);
  await pool.end().catch(() => undefined);

  process.exitCode = 1;
}
