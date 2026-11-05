# Sandbox customer screening evidence

## Scope and contract

`CUSTOMER_SCREENINGS_ENABLED` defaults to false. In the executable API it requires
pinned staging Postgres/Auth, a test provider key, and financial/demo flags off.
Only the API service needs this flag. It is independent of the draft, terms,
submission, verification and simulation flags. Existing submitted PF bindings are
required; no new customer is created by these routes.

| Endpoint | Body | Behavior |
| --- | --- | --- |
| GET `/v1/me/onboarding/screening` | none | Own cached observation, or null |
| POST `/v1/me/onboarding/screening` | `{}` | Reconcile or create the single sandbox evidence record |
| POST `/v1/me/onboarding/screening/refresh` | `{}` | Read the linked provider screening and save a new observation |

Authenticated, unsuspended PF customers only. Ownership comes from the verified
access token; client-selected customer/screening IDs and extra body fields are
rejected. Every response is `Cache-Control: no-store`. Strict private JSON parsing
avoids reflecting malformed request contents. No provider bodies or matches are
logged or returned. Disabled returns 503; missing/ambiguous bindings and stale
writes return 409; provider failures return sanitized 502.

The fixed request is `subject: {customer_id: <owned provider ID>}` with
`lists: [sanctions, pep]`. Capabilities must confirm test environment, customers
and compliance entitlements, and customers:read / screenings:read /
screenings:write for creation. Refresh does not require screenings:write.

## Durable intent, reconciliation and recovery

Migration 019 adds `peragus_customer_screenings`: one record per submitted local
customer, unique provider customer ID and screening ID, a random server-generated
idempotency key, sanitized observation, revision and refreshed_at. RLS is enabled
and public/anon/authenticated receive no table grants. Only trusted backend access
is intended. Test environment is enforced by a database constraint.

Before an external POST, reserve the intent and its key in Postgres. The body is
fixed by the immutable provider binding and these two lists. Retries use the same
key and body. Before creation, enumerate the customer's complete screening trail
(maximum 10 pages of 100); partial, malformed or ambiguous history fails closed.
One existing screening with the exact customer and list set is confirmed with a
fresh GET and linked as existing evidence. This also imports the manual staging
test without repeating a screening. Zero existing screenings causes the idempotent
POST; more than one requires operator reconciliation, never selection of the newest.
An unsupported list set also requires investigation instead of an automatic new POST.

A successful provider call followed by timeout or local save failure can be
recovered on the next start: list and GET the same record; if listing has not caught
up, POST the same body and key. Optimistic revision checks prevent an older response
from overwriting a newer local observation. Concurrent requests may receive 409
and safely read/retry. Keys are never exposed by the API. There is no automatic
scheduled re-screening, key reset, evidence deletion or history replacement.
If a request remains uncertain beyond the provider's idempotency retention,
reconcile manually before retrying creation; the retention duration is not assumed.

## Evidence semantics and limits

Identity capture and list screening are separate evidence:

- `identity_outcome` on the verification response is approved only when the session
  is completed and document, liveness and face match are all pass. Failure of one
  capture check yields rejected; missing, pending or review is unknown.
- Legacy `observed_outcome` still requires all four verification checks, including
  aml_name_screening, to pass for approved. An independent screening never mutates
  the provider's verification checks and never fabricates pass for AML.
- Sandbox simulation acknowledgment now compares the three identity checks. This
  allows a fresh GET to acknowledge an already approved capture without attempting
  to simulate a terminal verification again. `last_simulated_outcome` is an
  acknowledged sandbox outcome, not proof that a new POST happened in that request.
- Screening returns the provider's result, suggested_decision, status, requested
  lists, match count and IDs only. `review` is preserved even with zero matches;
  missing matches or contradictory `clear` with matches is rejected. No match names,
  list entries, contact signals, documents or provider raw responses are persisted.
- The provider describes customer_id screening as name-only today, without using
  the stored birth date. A clear result for fictional sandbox data proves plumbing,
  not a real person's compliance approval. Screening is point-in-time, not monitoring.

No combined approval endpoint or financial eligibility policy is introduced. Local
customer verification status stays draft; all responses keep operations_enabled=false.
There are no payment, wallet provisioning, withdrawal or bank-account calls, and
no hit adjudication API is exposed. Existing customer.updated webhook behavior is
unchanged; screening evidence is refreshed explicitly, not by a new subscription.

## Staging rollout and acceptance

1. Build the branch and apply migration 019 with the pinned staging guard.
2. Merge into develop and deploy the API. Leave simulation disabled. Enable only
   CUSTOMER_SCREENINGS_ENABLED for this acceptance step; no worker setting needed.
3. With the second PF test account, POST the empty screening body. It should link
   the single manually created screening without another external POST.
4. Repeat and verify the same screening ID. Refresh and verify completed/clear,
   both lists, zero matches and operations disabled. Read identity_outcome separately.
5. Verify the local PF remains draft and the existing settlement gate remains closed.
6. Disable screening, draft, terms, submission, verification and simulation features
   after acceptance. Keep the configured webhook receiver active.

Recorded external sandbox evidence (before this PR): capture checks pass, AML check
not_started; separate sanctions+PEP screening completed/clear with zero matches;
repeated screening POST returned the same ID and Idempotent-Replayed=true.
The new backend path still needs post-deploy staging acceptance. Tests cover durable
keys, recovery, ambiguous/foreign evidence, fail-closed results, sanitized storage,
account isolation, authentication, feature gates, RLS and optimistic concurrency.
