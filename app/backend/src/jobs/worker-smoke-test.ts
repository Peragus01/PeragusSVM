import type { PgBoss } from "pg-boss";
import { z } from "zod";

export const WORKER_SMOKE_QUEUE = "peragus-worker-smoke-test";
export const STAGING_PROJECT = "lybdkqkbwlfwvmmvstzi";
export const smokePayload = z.object({ diagnosticId: z.string().uuid() }).strict();

// This guard intentionally pins the known staging database, independently of NODE_ENV.
export function assertSmokeTestSafety(env: {
  DATABASE_URL?: string | undefined;
  OZAV_ONRAMP_WRITES_ENABLED: boolean;
  OZAV_OFFRAMP_WRITES_ENABLED: boolean;
  SOLANA_COSIGNING_ENABLED: boolean;
  SOLANA_CONTINGENCY_RESERVE_ENABLED: boolean;
  PERAGUS_SANDBOX_DEMO_ENABLED: boolean;
}): void {
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? ""); }
  catch { throw new Error("Smoke test requires the staging database"); }
  const pooler = url.hostname === "aws-1-sa-east-1.pooler.supabase.com"
    && url.port === "5432"
    && decodeURIComponent(url.username) === `postgres.${STAGING_PROJECT}`;
  const direct = url.hostname === `db.${STAGING_PROJECT}.supabase.co`
    && (url.port === "5432" || url.port === "")
    && decodeURIComponent(url.username) === "postgres";
  if (!pooler && !direct) {
    // Report comparisons only; never include any part of the supplied URL.
    const checks = {
      poolerHostMatches: url.hostname === "aws-1-sa-east-1.pooler.supabase.com",
      poolerPortMatches: url.port === "5432",
      poolerUserMatches: decodeURIComponent(url.username) === `postgres.${STAGING_PROJECT}`,
      directHostMatches: url.hostname === `db.${STAGING_PROJECT}.supabase.co`,
      directPortMatches: url.port === "5432" || url.port === "",
      directUserMatches: decodeURIComponent(url.username) === "postgres",
    };
    throw new Error("Smoke test requires the pinned staging database; checks=" + JSON.stringify(checks));
  }
  if (env.OZAV_ONRAMP_WRITES_ENABLED || env.OZAV_OFFRAMP_WRITES_ENABLED
    || env.SOLANA_COSIGNING_ENABLED || env.SOLANA_CONTINGENCY_RESERVE_ENABLED
    || env.PERAGUS_SANDBOX_DEMO_ENABLED) {
    throw new Error("Smoke test requires all financial and demo flags disabled");
  }
}

export async function registerWorkerSmokeTest(boss: PgBoss): Promise<void> {
  await boss.createQueue(WORKER_SMOKE_QUEUE, {
    retryLimit: 0, expireInSeconds: 30,
    retentionSeconds: 86400, deleteAfterSeconds: 86400,
  });
  await boss.work(WORKER_SMOKE_QUEUE, { pollingIntervalSeconds: 2, localConcurrency: 1 }, async ([job]) => {
    if (!job) throw new Error("Empty smoke test batch");
    const { diagnosticId } = smokePayload.parse(job.data);
    const result = { diagnosticId, processedAt: new Date().toISOString(), project: STAGING_PROJECT };
    console.info(JSON.stringify({ event: "worker_smoke_test_processed", jobId: job.id, ...result }));
    return result;
  });
  console.info(JSON.stringify({ event: "worker_smoke_test_ready", queue: WORKER_SMOKE_QUEUE, project: STAGING_PROJECT }));
}
