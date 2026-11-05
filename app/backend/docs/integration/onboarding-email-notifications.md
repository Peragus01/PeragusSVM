# Onboarding result notifications through Resend

## Scope and contracts

This extension reads the existing own-customer onboarding overview, registration snapshots, identity verification and independent screening repositories. It reuses the existing OZAV GET refresh services, including test capability checks, provider-customer binding validation and immutable submission binding. Browser redirects, term acceptance alone and webhook payload claims never approve identity. No operation permission or customer verification status is changed.

The dedicated worker polls only explicitly allowed test Auth user IDs every 60 seconds, refreshing existing provider records before evaluating a notification. It does not create a customer, verification, screening, charge, Pix or withdrawal. Existing signed webhook intake remains unchanged; notification progress does not require the customer to keep the browser open.

No reusable Resend backend integration existed in this repository. The sender uses the HTTPS POST /emails contract and Idempotency-Key header directly, without an SDK dependency. Resend API acceptance is recorded as `accepted`, never as delivered. Actual inbox delivery, bounce/complaint webhooks and production rollout are not included.

## Configuration and rollout

Apply migration 037 with the existing checksum migration runner to the pinned staging database. No existing encrypted draft or submission is rewritten. Review migration before applying; do not run against production.

Create a dedicated Railway staging service from app/backend, build `npm ci && npm run build`, start `npm run start:onboarding-emails`. Do not point it at the settlement worker start command. Provide the existing staging DATABASE_URL, DATABASE_SSL, SUPABASE_URL and test OZAV_API_KEY. All five financial/demo flags must remain false, as must identity and Pix simulation flags. The worker verifies the pinned staging Auth/database and OZAV test capabilities. A missing or invalid configuration fails closed.

Set these variables on the dedicated service and the staging API:

| Variable | Value |
| --- | --- |
| ONBOARDING_EMAILS_ENABLED | false by default; true only for authorized external acceptance |
| RESEND_API_KEY | Resend sending credential; server only; never VITE-prefixed |
| RESEND_FROM | A verified sender email, e.g. noreply@peragus.com.br; no display-name wrapper |
| ONBOARDING_EMAIL_ACCOUNT_URL | HTTPS staging account page, no credentials, query or fragment |
| ONBOARDING_EMAIL_TEST_USER_IDS | At most five comma-separated staging Supabase Auth UUIDs belonging to consenting test recipients; not customer IDs |

The API displays the email promise only for an allowed own account with a confirmed Auth address and a worker heartbeat within 180 seconds. It falls back to in-account tracking if disabled, unhealthy, unknown or not allowlisted. No secret, email address or allowlist is returned to the browser. Both deployments must use the same config and database. A healthy heartbeat is operational readiness, not a guarantee of future inbox delivery.

Do not add actual customer or document data for acceptance. Do not send any message until the account owner has authorized the test recipient and sending test. Use a verified Resend domain/sender. No emails were sent during implementation or automated tests.

## Result policy

- Receipt is shown only after the backend confirms linked submission. Terms alone do not claim a received registration.
- `pending_identity` and `action_required` explain the outstanding step; sandbox cannot complete hosted document capture. It is never represented as a completed real identity check.
- `approved` requires accepted terms, consistent binding, full mode, provider approved, no requirements pending, all three identity capture checks passed, and a completed clear screening with zero matches and clear decision. Wallet proof is an independent financial prerequisite, not a KYC result.
- `rejected` requires explicit rejection evidence. No sensitive compliance reasons, documents, name or CPF are emailed.
- `action_required` uses explicit provider requirements or expired verification.
- Other evidence stays in review or not submitted. All emails clearly say TESTE and never promise buying or payments are enabled.

The queue has one durable unique entry per customer/test/outcome. Repeated refreshes, webhook redeliveries and worker restarts cannot create a second entry. First observed terminal outcomes of allowlisted existing accounts can produce a test email: opt in deliberately. This is not a historical bulk mailing tool. An outcome is notified at most once per account in this milestone, including later regressions to the same outcome.

A dedicated session advisory lock serializes worker instances across the send boundary. Before sending, the first-attempt timestamp and fixed payload hash are persisted. Retries reuse the same UUID, recipient and exact content within a 23-hour window. Resend currently retains idempotency keys for 24 hours; after 23 hours unresolved entries become blocked for manual investigation, rather than risking another send after deduplication expires. Changed recipient, sender, template or account URL also blocks an attempted payload. Never reset first_attempt_at, regenerate event IDs or resend blocked entries automatically. Failed refresh prevents sends; pending old outcomes are superseded when fresh evidence changes. Only hashes and delivery metadata are stored; no mail body, recipient address, document or biometric is copied into the outbox or logged.

## Staging acceptance

1. Keep emails disabled while deploying migration/API/frontend/worker code and running synthetic checks.
2. Explicitly authorize one test email recipient, configure that Auth UUID and verified Resend sender, and enable only the notification flag on API/worker.
3. Submit synthetic registration using the existing real test journey and terms. Confirm receipt and a pending identity explanation instead of claiming analysis is complete. No new legal Peragus terms content or signature is invented by this change; existing term/consent contracts are preserved.
4. Verify GET /v1/me/onboarding/status returns review_state and email_notifications.enabled for the own allowlisted account; a different customer cannot view its status or choose a recipient.
5. Observe a provider-confirmed test outcome through an existing authorized test procedure. Do not enable identity simulation or financial flags to force acceptance. A test session without capture can remain pending indefinitely; this does not prove email outcome delivery.
6. Check one outbox row and the Resend accepted message ID locally; do not share addresses, credentials or bodies. Repeated refresh and worker restart must not duplicate it. Acceptance by Resend is not inbox delivery.
7. Stop the notification worker; after 180 seconds refresh the account and verify the email promise disappears. Restore only when operational.
8. Disable notification flag after acceptance if ongoing sending is not authorized. Review blocked rows through authorized DB tooling; no public retry/send endpoint exists.

Production remains blocked: existing provider adapters and this worker are pinned to test, live identity capture is not implemented here, production recipient/privacy/retention policy and bounce/complaint handling need a separate rollout. Changing a key or frontend label does not enable production.

References: https://resend.com/docs/api-reference/emails/send-email and https://resend.com/docs/dashboard/emails/idempotency-keys (24-hour retention verified 2026-10-31).
