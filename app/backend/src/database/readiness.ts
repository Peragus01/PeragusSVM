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

export type ReadinessCheckResult = "ok" | "failed";

export interface ReadinessProbes {
  /** Resolves when the database answers and is recorded for this money mode. */
  database?: () => Promise<void>;
  /** Resolves when the pg-boss schema is reachable. */
  queue?: () => Promise<void>;
  /** Resolves when OZAV answers capabilities for this money mode; omitted when no key is configured. */
  ozav?: () => Promise<void>;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: {
    database: ReadinessCheckResult;
    queue: ReadinessCheckResult;
    ozav: ReadinessCheckResult;
  };
}

export const READINESS_DATABASE_TIMEOUT_MS = 2_000;
export const READINESS_OZAV_TIMEOUT_MS = 3_000;
export const READINESS_OZAV_CACHE_MS = 30_000;
/** Database and queue results are shared by concurrent requests and cached this long (final review). */
export const READINESS_DATABASE_CACHE_MS = 2_000;

async function withTimeout(run: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function outcome(run: () => Promise<void>, timeoutMs: number): Promise<ReadinessCheckResult> {
  try {
    await withTimeout(run, timeoutMs);
    return "ok";
  } catch {
    // Never surface the cause: the endpoint is public.
    return "failed";
  }
}

/**
 * Builds the public readiness check. Reports only "ok"/"failed" per dependency.
 * The OZAV result (success or failure) is cached so an uptime monitor does not hammer OZAV.
 */
export function createReadinessChecker(
  probes: ReadinessProbes,
  options: { now?: () => number; ozavCacheMs?: number; timeoutMs?: number; ozavTimeoutMs?: number; databaseCacheMs?: number } = {},
): () => Promise<ReadinessReport> {
  const now = options.now ?? Date.now;
  const ozavCacheMs = options.ozavCacheMs ?? READINESS_OZAV_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? READINESS_DATABASE_TIMEOUT_MS;
  const ozavTimeoutMs = options.ozavTimeoutMs ?? READINESS_OZAV_TIMEOUT_MS;
  const databaseCacheMs = options.databaseCacheMs ?? READINESS_DATABASE_CACHE_MS;

  /** One in-flight probe shared by concurrent callers; its result is cached for `cacheMs`. */
  const shared = (probe: (() => Promise<void>) | undefined, missing: ReadinessCheckResult, probeTimeoutMs: number, cacheMs: number) => {
    let cache: { at: number; result: ReadinessCheckResult } | undefined;
    let inflight: Promise<ReadinessCheckResult> | undefined;
    return async (): Promise<ReadinessCheckResult> => {
      if (!probe) return missing;
      if (cache && now() - cache.at < cacheMs) return cache.result;
      inflight ??= outcome(probe, probeTimeoutMs)
        .then((result) => {
          cache = { at: now(), result };
          return result;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    };
  };
  const databaseCheck = shared(probes.database, "failed", timeoutMs, databaseCacheMs);
  const queueCheck = shared(probes.queue, "failed", timeoutMs, databaseCacheMs);
  const ozavCheck = shared(probes.ozav, "ok", ozavTimeoutMs, ozavCacheMs);

  return async () => {
    const [database, queue, ozav] = await Promise.all([databaseCheck(), queueCheck(), ozavCheck()]);
    const ready = database === "ok" && queue === "ok" && ozav === "ok";
    return { status: ready ? "ready" : "not_ready", checks: { database, queue, ozav } };
  };
}

/** `select 1` plus the recorded database environment (when enforced for this deployment). */
export function databaseReadinessProbe(
  pool: Pick<Pool, "query">,
  assertEnvironment?: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    await pool.query("select 1");
    if (assertEnvironment) await assertEnvironment();
  };
}

/**
 * Cheap pg-boss schema reachability check; never starts or touches jobs. With `worker`, the
 * background worker must also have beaten recently (final review I12: a dead worker means no
 * reconciliation, alerts or expiries, so the queue is reported failed).
 */
export function queueReadinessProbe(pool: Pick<Pool, "query">, worker?: () => Promise<void>): () => Promise<void> {
  return async () => {
    const { rows } = await pool.query("select to_regclass('pgboss.job') is not null as ok");
    if ((rows[0] as { ok?: unknown } | undefined)?.ok !== true) throw new Error("QUEUE_SCHEMA_MISSING");
    if (worker) await worker();
  };
}
