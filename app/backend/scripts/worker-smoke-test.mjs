import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { parse } from 'dotenv';
import { PgBoss } from 'pg-boss';
import { assertSmokeTestSafety, WORKER_SMOKE_QUEUE, STAGING_PROJECT } from '../dist/jobs/worker-smoke-test.js';

// Explicit file only: never falls back to .env or inherited DATABASE_URL.
const config = parse(await readFile(new URL('../.env.staging', import.meta.url)));
const flags = {};
for (const name of ['OZAV_ONRAMP_WRITES_ENABLED', 'OZAV_OFFRAMP_WRITES_ENABLED',
  'SOLANA_COSIGNING_ENABLED', 'SOLANA_CONTINGENCY_RESERVE_ENABLED', 'PERAGUS_SANDBOX_DEMO_ENABLED']) {
  if (config[name] !== 'false') throw new Error(`${name} must explicitly be false in .env.staging`);
  flags[name] = false;
}
assertSmokeTestSafety({ DATABASE_URL: config.DATABASE_URL, ...flags });
if (config.DATABASE_SSL !== 'true') throw new Error('Staging requires DATABASE_SSL=true');
const boss = new PgBoss({ connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, schema: 'pgboss', max: 1,
  migrate: false, supervise: false, schedule: false });
boss.on('error', () => console.error('Smoke test queue connection error (details suppressed)'));
try {
  await boss.start();
  if (!await boss.getQueue(WORKER_SMOKE_QUEUE)) throw new Error('Diagnostic queue absent: deploy and enable staging worker first');
  const diagnosticId = randomUUID();
  const jobId = await boss.send(WORKER_SMOKE_QUEUE, { diagnosticId }, { id: diagnosticId });
  if (!jobId) throw new Error('Diagnostic job was not published');
  console.info(JSON.stringify({ event: 'worker_smoke_test_published', jobId, diagnosticId, project: STAGING_PROJECT }));
  const deadline = Date.now() + 60000;
  let completed = false;
  while (Date.now() < deadline) {
    const job = await boss.getJobById(WORKER_SMOKE_QUEUE, jobId);
    if (job?.state === 'completed') {
      if (job.output?.diagnosticId !== diagnosticId || job.output?.project !== STAGING_PROJECT) throw new Error('Diagnostic output mismatch');
      console.info(JSON.stringify({ event: 'worker_smoke_test_completed', jobId, diagnosticId, state: job.state, output: job.output }));
      completed = true;
      break;
    }
    if (job?.state === 'failed' || job?.state === 'cancelled') throw new Error(`Diagnostic job ended: ${job.state}`);
    await setTimeout(1000);
  }
  if (!completed) throw new Error('Diagnostic not completed within 60 seconds; check Railway worker logs before publishing another job');
} catch {
  console.error('Smoke test failed. Check staging worker readiness, flags, and diagnostic job state. No credentials printed.');
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: true, timeout: 5000 });
}
