# Consolidated PF onboarding overview (staging)

## Endpoint and scope

`GET /v1/me/onboarding/status` returns one authenticated PF customer's stored
onboarding observations. It is read-only, test-only, and never calls the provider,
opens ciphertext, accepts terms, updates statuses, creates a screening or enqueues
a payment. No new migration or secret is required; migrations 010 through 019 must
already be applied.

Enable `CUSTOMER_ONBOARDING_STATUS_ENABLED=true` only on the staging API. It
defaults to false and the executable server enforces pinned staging database and
Auth. It does not require a provider key or encryption key of its own. Existing
webhook configuration still has its own key/secret requirements. All mutation
features may remain disabled. No worker setting is needed.

The endpoint uses existing email-confirmed authentication and own-customer
resolution. A missing profile returns the existing CUSTOMER_REQUIRED 403; create
it through the profile endpoint first. PJ onboarding remains unsupported (403),
as does a suspended customer. Disabled returns 503. Caller-selected query
parameters are rejected with 400, and no POST/PUT/PATCH action exists here.
Every response has Cache-Control:no-store. Storage failures or evidence linked to
a different provider customer return a generic 503 without internal details.

## Response sections

| Field | Meaning |
| --- | --- |
| customer | Own local ID, PF type and local verification status; no name, owner user ID or email |
| draft | Version/update time and whether it matches the submitted version; no form values |
| provider_terms | Session/version/state/acceptance/expiry metadata, without URL, token or encrypted evidence |
| registration | Submission state, provider status/mode, requirement counts and observation time |
| identity | Sanitized checks, three-check identity_outcome, legacy four-check all_checks_outcome and observation time |
| screening | Stored status/result, requested lists, match count, suggested decision and observation time |
| pending_steps | Stable codes describing recorded missing, pending or review stages |
| actions_enabled | API startup flags for draft/terms/submission/verification/screening, not user eligibility or a guarantee a request succeeds |
| operation_blockers | Always SANDBOX_ONLY and FINANCIAL_OPERATIONS_DISABLED |

Other fixed fields: environment=test, sandbox_only=true,
source=stored_observations, observation_freshness=not_evaluated,
operations_enabled=false. checked_at is the overview rendering time, **not** a
provider refresh time. Each observation retains its own timestamp; there is no
assumed freshness SLA, live compliance assessment, or combined approval. Empty
pending_steps does not mean a user can transact. Peragus-specific legal terms,
wallet ownership, financial eligibility and live compliance are outside this
read model; their completion is never implied by it.

The query selects explicit metadata only from the profile, draft, terms,
submission, verification and screening tables in one PostgreSQL statement, giving
one database snapshot. It never selects encrypted_payload, encrypted_token,
encrypted_acceptance, request_hash, idempotency_key or stored personal form data.
Provider IDs are used internally to reject inconsistent bindings and are not
exposed by this overview.

If a submission exists, provider_terms refers to **the terms session recorded on
that submission**, even if it was later replaced by an active session. Without a
submission it shows the active session. Expiry remains visible; expiry after a
linked submission does not retroactively erase its recorded acceptance or force
renewal in this read model. Before linking, expired/inactive accepted terms are a
renewal requirement. Metadata is not a cryptographic verification of the saved
acceptance; mutating flows keep their existing integrity checks.

## Pending codes

- INDIVIDUAL_DRAFT_REQUIRED
- PROVIDER_TERMS_REQUIRED / PROVIDER_TERMS_ACCEPTANCE_REQUIRED /
  PROVIDER_TERMS_RECOVERY_REQUIRED / PROVIDER_TERMS_RENEWAL_REQUIRED
- PROVIDER_SUBMISSION_REQUIRED / PROVIDER_SUBMISSION_PENDING
- IDENTITY_VERIFICATION_REQUIRED / IDENTITY_VERIFICATION_PENDING /
  IDENTITY_VERIFICATION_REJECTED
- SCREENING_REQUIRED / SCREENING_PENDING / SCREENING_REVIEW_REQUIRED
- PROVIDER_REQUIREMENTS_PENDING / PROVIDER_REQUIREMENTS_UNKNOWN
- PROVIDER_STATUS_NOT_APPROVED / PROVIDER_VERIFICATION_MODE_REVIEW_REQUIRED

Identity, screening and requirement codes apply after a linked submission. A
review screening remains review even with zero matches. A completed screening
must explicitly have result=clear, zero matches and suggested_decision=clear to
avoid the review code. Missing suggested decision is conservative unknown/review,
not inferred clear. The existing sandbox capture-approved/AML-not_started state
reports identity_outcome=approved and all_checks_outcome=null. Separate clear
screening never changes that AML check.

A changed draft version is shown as matches_submitted_version=false, without
resubmitting or rewriting the original intent. Multiple lifecycle resources are
shown separately; this endpoint does not synthesize an overall customer approval
or change the peragus_customers status.

## Frontend integration

Send the confirmed Supabase access token as Authorization: Bearer. Preserve that
header through any proxy and allowlist the exact new route. Use the machine codes
for translated UI labels. Display observed results as sandbox results, distinguish
local profile status from provider observations, and show observation times. Render
only enabled feature actions; keep financial actions unavailable. The simulation
helper must not be part of a real-user onboarding UI.

## Validation and rollout

Automated checks cover metadata-only reads, preserved submitted terms history,
expiry, missing stages, pending/rejected/review/unknown observations, revised
drafts, owner isolation, invalid query selectors, auth/PJ/suspension/feature gates,
inconsistent bindings and sanitized storage errors. TypeScript compilation and
existing screening, identity and customer-access regressions are required.

After merge into develop, deploy the API with the new flag true and all mutation,
simulation and financial flags false. Test the second PF account: stored identity
approved, separate screening clear, old AML check still not_started, profile draft,
operations false and all actions_enabled false. Verify the rejected PF remains a
different result. No migration is run for this feature. Post-deploy acceptance is
pending until these authenticated requests are observed in staging.

## Wallet proof extension

Migration 020 adds a metadata-only join to the verified test wallet. Apply it
before deploying this overview update. The response gains wallet (public address,
verified time, devnet context and signed-message proof type), actions_enabled.wallet,
and WALLET_OWNERSHIP_REQUIRED if absent. See customer-wallet-ownership.md for proof
creation, privacy, replay protection and the remaining frontend acceptance.
