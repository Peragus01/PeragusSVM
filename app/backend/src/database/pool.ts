import {
  Pool,
  type PoolConfig,
} from "pg";

export function createDatabasePool(
  connectionString: string,
  useSsl: boolean,
): Pool {
  const config: PoolConfig = {
    connectionString,
    max: 10,
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
