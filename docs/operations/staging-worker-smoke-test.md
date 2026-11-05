# Staging worker smoke test

Purpose: prove one diagnostic job is published, consumed by the Railway worker,
and completed in the pinned Supabase staging project lybdkqkbwlfwvmmvstzi.
The dedicated handler has no financial repository, OZAV client, or Solana client.

## Deployment and execution

1. Review and merge this change into develop only. Deploy that revision to the
   staging peragus-worker service. Do not deploy to main or production.
2. Check the worker DATABASE_URL targets the staging project and these flags are
   false: OZAV_ONRAMP_WRITES_ENABLED, OZAV_OFFRAMP_WRITES_ENABLED,
   SOLANA_COSIGNING_ENABLED, SOLANA_CONTINGENCY_RESERVE_ENABLED,
   PERAGUS_SANDBOX_DEMO_ENABLED. Do not copy secrets into chat or logs.
3. Set WORKER_SMOKE_TEST_ENABLED=true on the staging worker only. The startup
   guard rejects other databases and active financial/demo flags. Confirm the
   worker_smoke_test_ready log for the staging project.
4. Stop any local or other diagnostic-enabled workers connected to this database.
   This is necessary to attribute the consumption to Railway.
5. In app/backend on WSL, ensure .env.staging explicitly sets the five flags above
   to false, DATABASE_SSL=true, and the correct staging DATABASE_URL. Then run:

   ```bash
   npm run build
   node scripts/worker-smoke-test.mjs
   ```

The script reads only .env.staging; inherited DATABASE_URL and .env are ignored.
It starts no consumer, creates no queue, and disables PgBoss migration,
scheduling and supervision. It publishes exactly one UUID-correlated job and
polls for up to 60 seconds. Connection error details are suppressed.

## Evidence required

Keep the worker_smoke_test_published and worker_smoke_test_completed output,
including the jobId and diagnosticId. Match these identifiers with the
worker_smoke_test_processed event in the Railway staging worker deployment logs.
Completed status alone proves a consumer handled the job; the Railway log match
attributes it to the deployed worker. Neither startup logs nor unit tests prove
this end-to-end result.

On timeout, inspect that job and worker logs before publishing another job. The
job can complete after the script exits. Failed/cancelled jobs are not successes.
The diagnostic queue has no retries and retains jobs for up to one day subject
to PgBoss maintenance. No settlement or provider operations are invoked by its
handler. Existing financial queue consumers remain part of the worker and are
not paused by this diagnostic.

## Rollback

Set WORKER_SMOKE_TEST_ENABLED=false and redeploy the staging worker. If reverting
code, revert this change on develop and deploy the previous staging revision.
The empty diagnostic queue may remain harmlessly; no destructive cleanup is
required. Do not remove production data or reapply application migrations.

## Verification performed during implementation

- Backend TypeScript build passed.
- Eight focused diagnostic tests passed.
- Script syntax and git whitespace checks passed.
- Railway/Supabase end-to-end execution remains pending until evidence above is
  captured. The earlier 137 tests were not rerun.
