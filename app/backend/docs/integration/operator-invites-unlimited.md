# Operator invitations — dynamic capacity (staging-first)

This change removes the fixed five-admission cap **without opening public registration**. The operator-only routes still require a verified Supabase session, allowlisted operator identity, and AAL2 MFA. Financial operations remain disabled for newly admitted draft profiles.

## Database
Run migration `037_expand_operator_invites.sql` before deploying the updated backend. The migration retains existing slots, admitted users, invitations, revocations and immutable audit records, upgrades slot identifiers to integer, and creates a sequence for on-demand slot allocation.

An issue operation first locks an available, unadmitted slot; if none is available, a new slot is inserted atomically and assigned. Existing issued invitations and redeemed admissions are never displaced. The system has no configured admission quota; database capacity remains finite. The existing operator rate limit (10 attempts per 15-minute window), single-use codes, 1–168-hour expiration and idempotency are unchanged.

## API
- `POST /v1/admin/pilot-invites`: issue an email-bound invitation, returning the plaintext code **once**.
- `GET /v1/admin/pilot-invites`: last 50 invitations, newest first; authenticated allowlisted AAL2 operator only. No plaintext codes, hashes or recipient emails.
- `GET /v1/admin/pilot-invites/:id`: inspect one record.
- `POST /v1/admin/pilot-invites/:id/revoke`: revoke an unused invitation.

Do not log codes, put them in URLs or send them to analytics. The operator must copy and distribute the one-time secret through an appropriate private channel.

## Rollout and verification
1. Review schema migration against a database snapshot and run backend tests.
2. Apply the migration to **staging only**, then deploy backend with `PILOT_INVITES_ENABLED=true` and the existing email-bound invite HMAC key configured.
3. Use a separate allowlisted operator account with AAL2 MFA. Issue more than five invitations to distinct test emails and confirm the new slot allocation while no uninvited signup is accepted.
4. Redeem one invitation, verify one draft PF profile and one consumed slot, test replay, revocation and rate limiting.
5. Confirm `GET /v1/admin/pilot-invites` denies anonymous, normal customer and AAL1 users. Check no plaintext codes in history/logs.
6. Deploy the frontend console after the backend is verified, and only promote to production after explicit approval.

**Note:** This does not increase the number of invitations per user per month. That is a distinct referral program.
