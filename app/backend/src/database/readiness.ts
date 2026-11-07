import type { Pool, PoolClient } from "pg";
import { NotificationConfigurationError } from "../notifications/runtime-safety.js";

export async function verifyDatabaseConnection(pool: Pool) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      database_ok: boolean;
      role_ok: boolean;
      backend_tls: boolean;
      schema_ok: boolean;
    }>(`
    select current_database()='postgres' as database_ok,
      current_user='postgres' as role_ok,
      coalesce((select ssl from pg_stat_ssl where pid=pg_backend_pid()),false) as backend_tls,
      to_regclass('public.peragus_schema_migrations') is not null as schema_ok
  `);
    // pg_stat_ssl describes Supavisor -> Postgres, not this client's TLS session.
    // Verify the socket actually used by Node -> Supavisor on the pinned client.
    const tls =
      (
        client as PoolClient & {
          connection?: { stream?: { encrypted?: boolean } };
        }
      ).connection?.stream?.encrypted === true;
    const result = { ...rows[0], tls };
    const fields = [];
    if (!result.database_ok) fields.push("DATABASE_NAME");
    if (!result.role_ok) fields.push("DATABASE_ROLE");
    if (!result.schema_ok) fields.push("DATABASE_SCHEMA");
    if (!tls) fields.push("DATABASE_TLS");
    if (
      !result?.database_ok ||
      !result.role_ok ||
      !result.schema_ok ||
      !result.tls
    )
      throw new NotificationConfigurationError(
        "ONBOARDING_DATABASE_READINESS_FAILED",
        fields,
      );
    console.info(
      JSON.stringify({
        event: "database_connection_verified",
        environment: process.env.RAILWAY_ENVIRONMENT_NAME,
        ...result,
      }),
    );
  } finally {
    client.release();
  }
}
