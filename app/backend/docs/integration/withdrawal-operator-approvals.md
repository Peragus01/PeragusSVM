# Sandbox operator approval audit

This milestone adds a human approval audit record to an existing record-only
withdrawal request. It never executes, reserves funds, evaluates fees, authorizes
an on-chain send or enqueues a job. A future execution service must independently
revalidate provider/balance/fees, Travel Rule, destination, network and mint.

Apply migration 026 before deployment: existing customer withdrawal reads now
join approval records to expose approved and approval_recorded_at. The original
amount, destination and proof snapshot stay frozen. Public responses expose no
operator ID, reason or admin metadata. State remains recorded and withdrawal_started
false. These markers mean that execution has not been implemented, even when an
operator decision has been recorded. Previous request replays preserve economic
fields but reflect current approval audit status.

Flags and configuration:

- WITHDRAWAL_OPERATOR_APPROVALS_ENABLED=false by default.
- WITHDRAWAL_OPERATOR_USER_IDS: comma-separated Supabase Auth user UUIDs, up to
  five; defaults empty. Startup refuses enabled approvals without an allowlist.
- Operator account must be separate from every customer profile. A mistakenly
  allowlisted customer account still cannot access the admin resource or approve.
- The operator must have verified email and a Supabase MFA session at aal2.
- Financial, demo, Pix, simulation and quote creation flags stay false. Customer
  withdrawal read/record flag may remain false during operator setup.
- No worker, provider secret, signer or new dependency is required.

The exact admin resource is GET/POST
/v1/admin/withdrawal-requests/:id/approval. Authentication still validates the
bearer with the pinned Supabase project's GET /auth/v1/user. Only after that
server accepts the exact bearer token may the authenticator extract aal2 from
its JWT, checking subject binding, expected issuer/audience and unexpired claims.
Malformed, mismatched or unknown assurance never grants MFA privileges. Neither
browser request fields nor user-editable metadata can set actor or assurance.
The exact admin path is exempt from customer-profile *requirements*, not from
authentication or authorization; it rejects accounts that have customer profiles.
There is no generic /v1/admin bypass. Its handler separately enforces allowlist
and verified MFA before reading or recording a decision.

POST accepts only {request_id: UUID, reason: string}. Reason is trimmed, 10–300
characters and rejects control characters. No operator ID, amount, wallet,
provider ID, state or approval bypass is accepted. Admin responses are no-store
and errors never echo token, payload, reason or database details.

One INSERT SELECT copies the frozen withdrawal amount and wallet while
rechecking stored identity, accepted terms, screening, wallet proof, conversion
and provider bindings. This is approval of recorded sandbox evidence, not a claim
that provider observations or spendable balance have been refreshed. The audit
stores immutable actor, reason, time, aal2 and the approved amount/destination.
Unique withdrawal ID and operator/request ID prevent duplicate decisions;
replay with unchanged withdrawal/reason is 200, first insertion 201, changed
payload conflicts. The database rejects UPDATE and DELETE of approval records.
Revocation requires a future separate audit event, never editing this record.

Acceptance setup requires a dedicated operator account, verified email, TOTP
MFA enrollment and its Auth UUID in the server allowlist. Do not reuse either
existing test customer or put credentials/TOTP seeds in Railway. Keep the feature
disabled until setup is complete. Then test missing/invalid auth, nonallowlisted
identity, aal1, customer-account separation, strict input, first approval, replay,
conflicting reason and safe owner readback without provider/queue effects.
Disable the approval feature after staging acceptance. Mainnet remains out of
this milestone and no production key is used.
