import type { Pool } from "pg";

import { buildApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { createDatabasePool } from "./database/pool.js";
import { InMemorySettlementRepository } from "./repositories/in-memory-settlement-repository.js";
import { PostgresSettlementRepository } from "./repositories/postgres-settlement-repository.js";
import type { SettlementRepository } from "./repositories/settlement-repository.js";

const env = getEnv();

let pool: Pool | undefined;
let settlementRepository: SettlementRepository;

if (env.DATABASE_URL) {
  pool = createDatabasePool(
    env.DATABASE_URL,
    env.DATABASE_SSL,
  );

  settlementRepository =
    new PostgresSettlementRepository(pool);
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
});

if (pool) {
  const databasePool = pool;

  app.addHook("onClose", async () => {
    await databasePool.end();
  });
} else {
  app.log.warn(
    "DATABASE_URL is not configured; using volatile in-memory storage",
  );
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "Shutting down Peragus backend");
  await app.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
