# Staging email baseline and migration adoption

## Scope

The baseline under `supabase/` versions the welcome-email SQL history, deployed Edge Function v7, gateway JWT configuration, published Resend HTML/text template and a checksum manifest. It does not redeploy or enable email infrastructure. Backend startup continues to use only `app/backend/migrations/`; no cron or welcome trigger is installed by the backend runner.

## Reconciliation performed

On 2026-11-01 at 22:57:59 UTC, staging project `lybdkqkbwlfwvmmvstzi` adopted `037_expand_operator_invites.sql` into `public.peragus_schema_migrations` with SHA-256:

`9e1a260d658e308626c6062015665542d7f6434ed0f2df384a43b7482b6a4e8e`

The stored Supabase migration `20261101181204_expand_operator_invites_037` matched the backend file byte-for-byte. A transaction took the backend runner's advisory lock and verified the SQL hash, integer slot columns, sequence, removal of the legacy five-slot check, foreign key and absence of a conflicting ledger checksum. It inserted only the ledger row. The original ALTERs and sequence reset were not executed.

Post-check: the ledger entry exists with the expected checksum; the welcome queue still contains one sent row; the existing minute cron is active. No email send, template update, cron change, invitation change, customer change, secret read, production change or function deployment was performed.

## What remains intentionally pending

`037_add_onboarding_email_outbox.sql` is a different migration; its tables did not exist at the post-check and it was not marked applied. Deploy it through the existing backend runner or a separately reviewed tracked procedure before starting the KYC notification worker. Never adopt an absent schema just to clear a migration warning.

Do not rename either already published 037 file. Their full filenames are distinct and the runner hashes each separately. Use 038 or later for future backend schema changes.

The captured welcome code remains identical to its deployed version. Its lack of frozen payload hashes and a bounded deduplication retry window remains a separate reliability issue; versioning is not a claim that those safeguards have been implemented. Supabase Auth SMTP/redirects, Resend delivery feedback and an authorized end-to-end test also remain separate work.

## Verification

`test/welcome-infrastructure.test.ts` covers adoption without replay or sequence reset, repeat adoption, changed source history, schema drift, conflicting ledger checksums, confirmation deduplication, preservation of sent rows and denial of public claim RPCs. Tests use local synthetic data and no network email calls.

The full staging recovery and ownership policy is in `supabase/README.md`. Do not replay historical snapshots or restore queue rows without an explicit environment-specific recovery plan.
