# Staging invitation email delivery

Scope: Supabase `lybdkqkbwlfwvmmvstzi`, Railway **staging**, integration branches `develop` and `feat/frontend-mvp-integration`. Never enable this configuration in production. Existing invitations are not backfilled or resent.

## Issuance and security

With `INVITE_EMAIL_OUTBOX_ENABLED=true`, email issuance returns `code:null`. One SQL statement allocates a slot, creates the invitation and inserts the outbox. Queue failure rolls back all three. Existing `(operator_user_id,request_id)` uniqueness handles concurrent repeats and rejects changed payloads. AES-256-GCM encrypts the normalized address, code and complete serialized provider body, using authenticated purpose, test environment, invitation ID, version and key ID. A dedicated key must remain available until all pending payloads using it have been purged. Browser roles have no outbox access.

Operator list/read expose only delivery state, confirmation timestamps, safe error categories and retry-blocked indicator. MFA, operator allowlist, client/operator separation and rate limits remain enforced by the API. No endpoint retrieves the encrypted payload or recovers the code/address. Existing manually issued invitations retain their old behavior.

## Dedicated worker

Start `npm run start:invite-emails` from `/app/backend` after building. It is a separate Railway staging service, with session-mode Postgres (port 5432), no OZAV key, and all financial/demo flags disabled. The worker polls every 10 seconds, serializes workers with a session advisory lock and locks the actual invitation row across the bounded Resend call. Revocation, redemption and expiry UPDATEs wait for the same row lock; an advisory lock alone would not protect them. Always acquire invite before outbox to match the terminal-transition trigger.

A durable `sending` attempt is committed before the send transaction. A crash, provider timeout/5xx/409 or failed acceptance write leaves an uncertain result and retries the **same encrypted message and idempotency key**, at most every five minutes. A definitive rejection stops automatic retries. `accepted` requires a provider ID. `delivered` requires provider delivery evidence obtained by GET; unavailable/forbidden reads leave `accepted` unchanged. Delivery timestamps represent when evidence was observed, not a fabricated provider event timestamp.

Resend documents a **24-hour** idempotency window: https://resend.com/docs/dashboard/emails/idempotency-keys (verified 2026-11-04). Automatic retries stop after **23 hours from the first durable attempt**, leaving `uncertain` + `retry_blocked`, purging content and preserving audit. Operator review must reconcile with provider logs; do not issue a replacement solely to simulate success. Provider retrieval: https://resend.com/docs/api-reference/emails/retrieve-email.

The invite must be issued and have at least 15 seconds remaining immediately before dispatch; HTTP is limited to 10 seconds. An accepted email cannot be recalled. If send wins the lock, a later revocation/redemption may commit after acceptance, and its code is still governed by current invitation state. If revocation/redemption wins, no send occurs. Expiration governs redemption independently of email delivery and is checked with database wall clock, including again after locks are acquired.

Ciphertext is removed immediately on acceptance, definitive failure, invalid payload, terminal invitation transition, expiry cleanup or retry-window exhaustion. Immutable invitation audit, attempt count, first-attempt time, provider ID and delivery metadata remain. Uncertain terminal transitions are never relabeled as a proved send failure.

## Configuration and release

API: existing pilot invitation config plus `INVITE_EMAIL_OUTBOX_ENABLED`, dedicated base64 32-byte `INVITE_EMAIL_ENCRYPTION_KEY`, `INVITE_EMAIL_ENCRYPTION_KEY_ID`, `INVITE_EMAIL_FROM` (domain peragus.com.br). Worker: same encryption settings, `PILOT_INVITE_EMAIL_HASH_KEY`, `DATABASE_URL`, `DATABASE_SSL`, `SUPABASE_URL`, and `RESEND_API_KEY`. Reference the API key/config from the existing email worker rather than copying secrets. The API does not need a Resend key.

Apply `040_add_invite_email_outbox.sql` only to staging, under migration lock `(808613,1)`, recording its exact SHA-256 in `peragus_schema_migrations` in the same transaction. First compare the full current ledger against committed migrations, check 040 is unused, and inspect the Railway staged batch before accepting it. Enable API delivery only after the migration and code are available, then deploy the dedicated worker.

The email links to the verified integration branch alias at `/cadastro`; no code/address is included in URL parameters. The page requires invitation/email validation before Auth signup, then confirmed email and a fresh authenticated session for atomic one-use redemption. Confirmation and MFA are human actions; do not fabricate operator JWTs or use administrative email confirmation for acceptance evidence.

## Verification

`test/invite-email-processing.test.ts` runs embedded state/failure tests plus independent-connection PostgreSQL tests when `TEST_INVITE_DATABASE_URL` points to a disposable localhost database named `invitation_test`. CI provides PostgreSQL 17. The real database tests cover concurrent same-request issuance, duplicate targets, two workers, revocation/redemption while a send holds the invitation lock, rollback and uncertain recovery. Tests never connect to staging or send email.
