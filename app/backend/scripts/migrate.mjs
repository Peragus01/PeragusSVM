import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { databaseEnvironmentFor } from "./lib/database-environment.mjs";
import { runMigrations } from "./lib/migration-runner.mjs";

const backendDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const migrationsDirectory = path.join(backendDirectory, "migrations");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to run migrations");
}

// Fail before touching the database when the deployment is unset or unknown
// (only staging|production); the uncaught error exits non-zero.
databaseEnvironmentFor(process.env.PERAGUS_DEPLOYMENT_ENV);

const pool = new Pool({
  connectionString,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  const client = await pool.connect();

  try {
    // The environment is recorded right after 043 in the same transaction
    // (Ruling 40) and again, idempotently, at the end; a different recorded
    // value aborts with DATABASE_ENVIRONMENT_CONFLICT (non-zero exit below).
    const { appliedCount, environment } = await runMigrations({
      client,
      migrationsDirectory,
      deploymentEnv: process.env.PERAGUS_DEPLOYMENT_ENV,
      log: (line) => console.log(line),
    });

    console.log(`Migrations concluídas: ${appliedCount} aplicada(s).`);
    console.log(`Ambiente do banco: ${environment}.`);
  } finally {
    client.release();
  }
} catch (error) {
  console.error(
    "Falha ao aplicar migrations:",
    error instanceof Error ? error.message : error,
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}
