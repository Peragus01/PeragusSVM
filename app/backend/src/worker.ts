import { ImportOzavOnrampEventsService } from "./application/import-ozav-onramp-events.js";
import { ReconcileOzavOnrampService } from "./application/reconcile-ozav-onramp.js";
import { TransitionSettlementService } from "./application/transition-settlement.js";
import { getEnv } from "./config/env.js";
import { createDatabasePool } from "./database/pool.js";
import {
  createJobQueue,
  ensureSettlementQueues,
} from "./jobs/pg-boss.js";
import {
  SETTLEMENT_ORCHESTRATION_QUEUE,
  SettlementOrchestrationHandler,
  type SettlementOrchestrationJob,
} from "./jobs/settlement-orchestration.js";
import { OzavClient } from "./providers/ozav-client.js";
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

const pool = createDatabasePool(
  env.DATABASE_URL,
  env.DATABASE_SSL,
);

const repository =
  new PostgresSettlementRepository(pool);

const ozavRepository =
  new PostgresOzavOnrampRepository(pool);

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

const boss = createJobQueue(
  env.DATABASE_URL,
  env.DATABASE_SSL,
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
      const ozav = await ozavReconciler.execute(
        result.settlementId,
      );

      console.info(
        JSON.stringify({
          event: "settlement_job_processed",
          jobId: job.id,
          ...result,
          status: ozav.settlementStatus,
          ozav,
        }),
      );

      return {
        ...result,
        status: ozav.settlementStatus,
        ozav,
      };
    },
  );

  console.info(
    JSON.stringify({
      event: "worker_started",
      queue: SETTLEMENT_ORCHESTRATION_QUEUE,
      concurrency: env.JOB_CONCURRENCY,
      ozavEnvironment: "test",
    }),
  );
} catch (error) {
  console.error("WORKER STARTUP ERROR:", error);

  await boss.stop().catch(() => undefined);
  await pool.end().catch(() => undefined);

  process.exitCode = 1;
}
