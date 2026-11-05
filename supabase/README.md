# Staging email infrastructure

This directory captures existing infrastructure from staging project `lybdkqkbwlfwvmmvstzi` on 2026-11-01. It is a versioned baseline, not a deployment instruction. No email, template, function, cron job or Auth setting is changed by merging these files.

## Three separate journeys

1. Supabase Auth confirmation/reset: Auth owns its template and redirect settings; optional Resend SMTP transports it. Those settings are not captured by this baseline and remain to be audited.
2. Confirmed-account welcome: `auth.users` trigger → `internal.welcome_email_outbox` → pg_cron/pg_net → `process-welcome-email` v7 → published Resend template alias `peragus-boas-vindas`.
3. Onboarding/KYC result: the separate Node worker and backend outbox. It is not the welcome queue and must not share its trigger, scheduler or idempotency keys.

## Captured baseline

The timestamped SQL files preserve the historical statements already recorded in `supabase_migrations.schema_migrations`, with a final newline normalized for files. The last file is the same operator-invite migration also owned by the backend runner; it is retained here for provenance, not as a second future migration owner.

The Edge Function is an unchanged copy of deployed version 7 with gateway JWT verification enabled. The HTML/text files capture the published Resend template and retain its production website links, logo and `FIRST_NAME` expression. Export metadata reported no declared variables despite that expression; verify rendering before a future template update. Do not automatically recreate or republish this template.

The scheduler reads the existing Vault secret named `peragus_welcome_scheduler_service_key`; no secret value is exported. The function expects server-side `RESEND_API_KEY`, `RESEND_FROM`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. Never put their values in Git, templates, browser variables or logs. The captured source is staging-only; do not deploy it to another project by merely changing a URL.

## Migration ownership and reconciliation

- Backend migrations remain immutable and are tracked by filename plus SHA-256 in `public.peragus_schema_migrations`.
- Welcome infrastructure is tracked by timestamp in `supabase_migrations.schema_migrations` and must remain an explicitly deployed Supabase concern.
- `20261101181204_expand_operator_invites_037` was applied through Supabase, while the identical backend file was absent from the backend ledger.
- `app/backend/scripts/sql/reconcile-operator-invites-ledger.sql` adopts only that exact migration after checking the stored SQL SHA-256 and resulting schema. It takes the same advisory lock as the backend migration runner and inserts at most one ledger row. It does not rerun ALTERs, reset the sequence, touch invite/customer records, or claim other migrations are applied.
- Two different files already use prefix 037. The runner uses full filenames, not numeric prefixes. Keep both existing names/checksums; future backend migrations must use 038 or later. Do not rename a file already applied in any environment.
- The KYC email-outbox migration is independent. Its missing schema/ledger entry must not be adopted as though it had run.

Do not run a blanket `supabase db push` or replay these historical snapshots on an existing environment. Do not add the welcome snapshots to the backend migration directory or its startup command. First compare histories, check schema and privileges, and review any proposed deployment. Replaying scheduler SQL can change a live schedule.

For disaster recovery into a separately authorized staging project: review SQL in chronological order, preserve private schema/RPC grants, provide secrets through the platform, publish the reviewed template and function with JWT verification, then configure the scheduler explicitly. Keep scheduling disabled until the recipient/test authorization is established. Restore queue state from backup; never backfill confirmed users or reset sent rows as part of bootstrap.

## Verified behavior and remaining work

The queue is keyed by Auth user ID; confirmation enqueues once. RPC execution is restricted to service_role; user/anon callers cannot claim recipients. Cron success proves dispatch execution, not delivery. Resend acceptance is not inbox delivery.

This baseline deliberately does not change existing retry policy: five attempts, recovery of stale processing claims, and a stable per-user Resend idempotency key. It lacks a persisted payload hash and deduplication-window cutoff, so late retries and template changes need a separate reliability change. Do not replay old failures manually. Bounce/complaint feedback, retention, privacy review, signup/invite ordering, staging links, SMTP configuration and end-to-end acceptance remain separate tasks.
