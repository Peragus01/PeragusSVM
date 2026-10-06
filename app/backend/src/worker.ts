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
import { PostgresSettlementRepository } from "./repositories/postgres-settlement-repository.js";

const env = getEnv();

if (!env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required to start the worker",
  );
}

const pool = createDatabasePool(
  env.DATABASE_URL,
  env.DATABASE_SSL,
);

const repository =
  new PostgresSettlementRepository(pool);

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

      console.info(
        JSON.stringify({
          event: "settlement_job_processed",
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
    }),
  );
} catch (error) {
  console.error("WORKER STARTUP ERROR:", error);

  await boss.stop().catch(() => undefined);
  await pool.end().catch(() => undefined);

  process.exitCode = 1;
}
