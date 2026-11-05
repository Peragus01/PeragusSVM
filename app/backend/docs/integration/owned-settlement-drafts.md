# Owned settlement records — staging isolation milestone

## Purpose

Create a non-executable settlement record for each authenticated PF/PJ customer
and exercise tenant isolation without approving KYC/KYB or starting payments.
This is a staging-only diagnostic/data-isolation capability, not an on-ramp or a
payment order. It does not replace the existing POST /v1/settlements route, which
remains blocked by CUSTOMER_NOT_APPROVED / OPERATIONS_NOT_ENABLED.

New POST /v1/settlement-drafts is disabled by default. It is enabled only with
SETTLEMENT_DRAFTS_ENABLED=true on the staging API. Startup requires the pinned
Supabase staging database, its staging Auth project, and all five existing
financial/demo flags false. There are no frontend changes in this milestone.

## Backend contract

A confirmed Supabase access token and an existing non-suspended customer profile
are required. The server derives customer_id from the authenticated user, never
from the body, header or query string. A draft KYC profile may create these
records because they cannot move money; this does not grant payment permission.

POST /v1/settlement-drafts accepts the same strict fields as settlement creation:

```json
{
  "request_id": "staging-isolation-001",
  "corridor_id": "abababababababababababababababababababababababababababababababab",
  "payer_wallet": "11111111111111111111111111111112",
  "recipient_wallet": "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
  "source_amount": "1",
  "destination_amount": "1",
  "expires_at": "<future ISO 8601 timestamp>"
}
```

Amounts are positive base-unit integer strings, not BRL amounts or a quote. Wallet
addresses here are only syntactically checked; this endpoint does not establish
wallet ownership, reserve balances, validate a corridor configuration or promise
execution. No provider customer or wallet is linked.

201 on first creation, 200 on identical replay. `data` includes the existing
settlement fields plus `customer_id` and `record_only: true`. `status` remains
`created`, which is a stored lifecycle label, not payment readiness. `meta` is:

```json
{
  "idempotent_replay": false,
  "record_only": true,
  "job_enqueued": false,
  "operations_enabled": false
}
```

Location points to GET /v1/settlements/{id}; that read succeeds only for the owner.
Idempotency-Replayed is false/true. Same customer plus same request_id and changed
payload returns 409 IDEMPOTENCY_CONFLICT without inserting another row. Another
customer may use that same request_id with identical or different details and gets
a distinct row. The original global namespace is retained only for legacy rows
where customer_id is null. Ownership-spoofing/body fields such as customer_id,
record_only or verification_status are rejected with 400. Expired new requests
return 422. Replays follow the existing creation service semantics (including
recovery of an identical previously created request after its expiry).

SETTLEMENT_DRAFTS_DISABLED (503) means the capability is off. Missing/invalid
identity still gets 401; missing profile or suspended customer gets 403. The same
foreign/missing/legacy 404 policy applies to all existing settlement subresources.
The frontend /api proxy must add this exact path to its allowlist and continue to
forward Authorization if a staging-only diagnostic UI is built; no proxy changes
are included here. Normal product payment UI must not treat this as payment creation.

## Defense in depth

- This route has no job publisher, funder, provider or Solana dependency.
- A customer-scoped repository creates records with record_only=true.
- No transition API or promotion API is added. Original financial POST gates stay closed.
- PostgreSQL requires record-only rows to have an owner and status=created.
- A trigger forbids clearing the marker or reassigning a record-only row.
- The normal status-update repository excludes record-only rows.
- SettlementOrchestrationHandler rejects record-only rows before the worker calls
  initiation/reconciliation. If a job is manually published by mistake, the existing
  retry/dead-letter policy applies; do not publish such a job as a test.
- Legacy records are not relabeled or assigned to customer accounts.

## Deployment sequence — staging only

No database changes or deploy are performed when preparing this PR. Before merge:

1. Fetch this branch into a separate worktree and copy the existing .env.staging
   locally with mode 600. Keep the file untracked. npm ci and npm run build.
2. Apply migration 011 through the existing destination-guarded migration command
   in customer-auth-v1.md. It requires the pinned staging project and SSL, then
   the migration runner checks/skips the prior ten migrations. 011 adds the marker,
   unique indexes and immutable-marker trigger; it does not insert a settlement.
3. Merge into develop, never main. Deploy the same revision to the staging API
   and peragus-worker. Keep SETTLEMENT_DRAFTS_ENABLED absent/false until both
   revisions are deployed successfully. The worker needs the new marker guard.
4. Set SETTLEMENT_DRAFTS_ENABLED=true on PeragusSVM staging only, not the worker.
   Leave WORKER_SMOKE_TEST_ENABLED=false and all five financial/demo flags false.
5. Confirm /health=200 and unauthenticated /v1/me=401. Use the existing confirmed
   PF and PJ accounts; do not register more accounts or reapply earlier migrations.

The migration removes the old global request_id unique constraint after creating
separate owned/legacy unique indexes, within the migration runner transaction.
The pre-011 unauthenticated legacy INSERT's ON CONFLICT(request_id) is incompatible
with that change. The currently authenticated deployed API already blocks those
writes, so no such path should run during this rollout. Do not roll back to a
pre-authentication API or run old demo writers after applying 011.

## Staging evidence to capture

Use one stable payload and request_id for this acceptance sequence:

1. PF creates its record (201); capture ID_PF and customer ID, record_only=true,
   job_enqueued=false, operations_enabled=false.
2. Identical PF replay gives 200 and ID_PF. Modified amount for that same customer
   and request_id gives 409.
3. PJ creates using the same request_id (201); capture ID_PJ, distinct from ID_PF.
4. Each account GETs its own ID (200); PF GET ID_PJ and PJ GET ID_PF both give 404.
5. Financial POST /v1/settlements remains 403 CUSTOMER_NOT_APPROVED for the draft
   accounts. Do not enable financial writes or submit an on-ramp.
6. Read-only SQL in the pinned staging database confirms two customer-owned rows
   and zero jobs in settlement-orchestration for those two IDs. Keep IDs for audit;
   do not delete shared legacy data or rerun the earlier worker smoke test.

Local tests use actual SQL via embedded PostgreSQL, injected authenticated PF/PJ
actors and a publisher/funder that throw if invoked. They include two-way foreign
access on every existing settlement subresource, concurrent replay/conflict,
legacy namespace separation and database/worker non-execution controls. They do
not replace the staging sequence above or establish production readiness.

## Rollback and next milestone

Disable SETTLEMENT_DRAFTS_ENABLED and redeploy the staging API. Retain schema and
records; no destructive rollback SQL is needed. Keep a worker revision with the
record_only guard. Do not recreate global request_id uniqueness after different
customers have legitimately used the same value.

Records from this endpoint never become real payments. A later payment milestone
must create a new executable instruction after provider-backed approval, wallet
binding, correct per-customer provider routing, explicit financial authorization
and durable outbox publication. No authentication or KYC rule is relaxed here.
