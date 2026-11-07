import { Pool, type PoolConfig } from "pg";

export function createDatabasePool(
  connectionString: string,
  useSsl: boolean,
): Pool {
  const config: PoolConfig = {
    connectionString,
    // Four services share a 15-session Supavisor budget. API + worker each
    // have a second (pg-boss) pool; 6 pools x 2 leaves headroom for operations.
    max: 2,
    application_name: `peragus:${process.env.RAILWAY_ENVIRONMENT_NAME ?? "local"}:${process.env.RAILWAY_SERVICE_NAME ?? "app"}`,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  };

  if (useSsl) {
    config.ssl = {
      rejectUnauthorized: false,
    };
  }

  return new Pool(config);
}
