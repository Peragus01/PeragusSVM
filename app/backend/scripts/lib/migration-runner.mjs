import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  databaseEnvironmentFor,
  recordDatabaseEnvironment,
} from "./database-environment.mjs";

// Migration that creates peragus_database_environment (Ruling 40): the runner
// records the environment right after it, inside the same transaction, so the
// data backfills of the following migrations pass the row-environment guard.
export const ENVIRONMENT_MIGRATION_PREFIX = "043_";

const MIGRATION_FILENAME = /^\d+_[a-z0-9_]+\.sql$/;

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function listMigrationFilenames(migrationsDirectory) {
  return (await readdir(migrationsDirectory))
    .filter((filename) => MIGRATION_FILENAME.test(filename))
    .sort();
}

/**
 * Applies every pending migration in filename order, one transaction each.
 * `client.query(text, params?)` runs one statement; `executeScript(text)` runs a
 * multi-statement file (defaults to client.query, which `pg` runs with the
 * simple protocol). `stopBefore` (tests only) stops before that filename and
 * skips the final environment record.
 */
export async function runMigrations({
  client,
  migrationsDirectory,
  deploymentEnv,
  executeScript = (sql) => client.query(sql),
  log = () => {},
  stopBefore,
}) {
  // Unset or unknown deployment fails before touching the database.
  databaseEnvironmentFor(deploymentEnv);

  let appliedCount = 0;

  await client.query("select pg_advisory_lock($1, $2)", [808613, 1]);

  try {
    await client.query(`
      create table if not exists peragus_schema_migrations (
        filename text primary key,
        checksum text not null
          check (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default now()
      )
    `);

    await client.query(
      "alter table peragus_schema_migrations enable row level security",
    );

    for (const filename of await listMigrationFilenames(migrationsDirectory)) {
      if (stopBefore && filename >= stopBefore) {
        return { appliedCount, environment: null };
      }

      const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
      const fileChecksum = checksum(sql);
      const recordsEnvironment = filename.startsWith(ENVIRONMENT_MIGRATION_PREFIX);

      const existing = await client.query(
        "select checksum from peragus_schema_migrations where filename = $1",
        [filename],
      );

      if (existing.rows.length === 1) {
        if (existing.rows[0].checksum !== fileChecksum) {
          throw new Error(`Migration ${filename} changed after being applied`);
        }

        // A database migrated before Ruling 40 may hold 043 without the
        // environment row; record it before any later migration runs.
        if (recordsEnvironment) {
          await recordDatabaseEnvironment(client, deploymentEnv);
        }

        log(`Ignorada: ${filename}`);
        continue;
      }

      await client.query("begin");

      try {
        await executeScript(sql);

        if (recordsEnvironment) {
          await recordDatabaseEnvironment(client, deploymentEnv);
        }

        await client.query(
          "insert into peragus_schema_migrations (filename, checksum) values ($1, $2)",
          [filename, fileChecksum],
        );

        await client.query("commit");
        appliedCount += 1;
        log(`Aplicada: ${filename}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    // Final idempotent record: a different recorded value aborts with
    // DATABASE_ENVIRONMENT_CONFLICT.
    const environment = await recordDatabaseEnvironment(client, deploymentEnv);

    return { appliedCount, environment };
  } finally {
    await client.query("select pg_advisory_unlock($1, $2)", [808613, 1]);
  }
}
