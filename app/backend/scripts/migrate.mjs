import "dotenv/config";

import { createHash } from "node:crypto";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const backendDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const migrationsDirectory = path.join(
  backendDirectory,
  "migrations",
);

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const pool = new Pool({
  connectionString,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

function checksum(content) {
  return createHash("sha256")
    .update(content)
    .digest("hex");
}

async function migrate() {
  const client = await pool.connect();
  let appliedCount = 0;

  try {
    await client.query(
      "select pg_advisory_lock($1, $2)",
      [808613, 1],
    );

    await client.query(`
      create table if not exists peragus_schema_migrations (
        filename text primary key,
        checksum text not null
          check (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default now()
      )
    `);

    await client.query(`
      alter table peragus_schema_migrations
      enable row level security
    `);

    const filenames = (await readdir(migrationsDirectory))
      .filter((filename) =>
        /^\d+_[a-z0-9_]+\.sql$/.test(filename)
      )
      .sort();

    for (const filename of filenames) {
      const filePath = path.join(
        migrationsDirectory,
        filename,
      );

      const sql = await readFile(filePath, "utf8");
      const fileChecksum = checksum(sql);

      const existing = await client.query(
        `
          select checksum
          from peragus_schema_migrations
          where filename = $1
        `,
        [filename],
      );

      if (existing.rowCount === 1) {
        const recordedChecksum =
          existing.rows[0].checksum;

        if (recordedChecksum !== fileChecksum) {
          throw new Error(
            `Migration ${filename} changed after being applied`,
          );
        }

        console.log(`Ignorada: ${filename}`);
        continue;
      }

      await client.query("begin");

      try {
        await client.query(sql);

        await client.query(
          `
            insert into peragus_schema_migrations (
              filename,
              checksum
            )
            values ($1, $2)
          `,
          [filename, fileChecksum],
        );

        await client.query("commit");

        appliedCount += 1;
        console.log(`Aplicada: ${filename}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    console.log(
      `Migrations concluídas: ${appliedCount} aplicada(s).`,
    );
  } finally {
    try {
      await client.query(
        "select pg_advisory_unlock($1, $2)",
        [808613, 1],
      );
    } finally {
      client.release();
    }
  }
}

try {
  await migrate();
} catch (error) {
  console.error(
    "Falha ao aplicar migrations:",
    error instanceof Error ? error.message : error,
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}
