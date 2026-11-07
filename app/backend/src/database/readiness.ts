import type { Pool } from "pg";

export async function verifyDatabaseConnection(pool: Pool) {
  const { rows } = await pool.query<{
    database_ok: boolean;
    role_ok: boolean;
    tls: boolean;
    schema_ok: boolean;
  }>(`
    select current_database()='postgres' as database_ok,
      current_user='postgres' as role_ok,
      coalesce((select ssl from pg_stat_ssl where pid=pg_backend_pid()),false) as tls,
      to_regclass('public.peragus_schema_migrations') is not null as schema_ok
  `);
  const result = rows[0];
  if (
    !result?.database_ok ||
    !result.role_ok ||
    !result.schema_ok ||
    !result.tls
  )
    throw new Error("ONBOARDING_DATABASE_READINESS_FAILED");
  console.info(
    JSON.stringify({
      event: "database_connection_verified",
      environment: process.env.RAILWAY_ENVIRONMENT_NAME,
      ...result,
    }),
  );
}
