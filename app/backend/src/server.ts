import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

import { buildApp } from "./app.js";
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
import { InMemorySettlementRepository } from "./repositories/in-memory-settlement-repository.js";
import { PostgresSettlementRepository } from "./repositories/postgres-settlement-repository.js";
import type { SettlementRepository } from "./repositories/settlement-repository.js";

const env = getEnv();

let pool: Pool | undefined;
let boss: PgBoss | undefined;
let settlementRepository: SettlementRepository;
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
