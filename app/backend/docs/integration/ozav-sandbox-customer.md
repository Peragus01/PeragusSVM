# OZAV sandbox customer fixture

This milestone tests API customer creation and a durable, authenticated PF-to-provider link. It does not implement real customer onboarding, KYC, a hosted invitation, verification submission, or financial execution. PJ profiles remain supported by customer access but cannot invoke this PF fixture endpoint.

## Contract

`GET /v1/me/ozav-sandbox-customer` returns the current customer's local link snapshot, or `data: null`. It does not refresh provider status.

`POST /v1/me/ozav-sandbox-customer` accepts an empty JSON object and requires a confirmed Supabase session and an active PF profile. Customer identity comes from authentication. Caller-supplied identity, email, CPF, ownership, or provider IDs are rejected. Missing authentication returns 401; PJ returns 403; a disabled feature returns 503.

The server generates deterministic sandbox data: a reserved example.com email, fixed test name, checksum-valid synthetic CPF and a customer-specific external reference. These values do not represent the person's legal identity and must never be reused for live onboarding. They are not guarantees of an unassigned legal identifier. Only sandbox keys and a capabilities response identifying the test environment are accepted.

The provider request explicitly selects `verification_mode: full`, `custody_model: managed` and `monitoring: false`. No reliance attestation is made. The supplied OpenAPI has conflicting custody prose; an unsupported explicit selection must fail, without silently falling back. No effective custody model is inferred from the request. No verification sessions, documents, wallets, accounts, transfers or signatures are created by this flow.

First successful local binding returns 201; subsequent requests return 200 and `Idempotency-Replayed: true`. The result includes `environment: test`, `sandbox_fixture: true`, link state, OZAV customer ID, provider status, verification mode and `operations_enabled: false`. A missing provider verification mode remains null. Provider approval never approves the local profile or enables operations.

## Persistence and failure handling

Migration 012 creates a separate test-only link table with one row per local customer, a unique provider ID, RLS and no browser grants. It stores the request hash and fixed idempotency key, not the fixture CPF, email, documents or raw provider responses.

An intent is reserved before the provider call. A timeout, invalid response or local completion failure preserves the pending intent. Repeating the same endpoint uses identical data and the same idempotency key. Do not delete pending intents or replace their keys to work around an uncertain response. Provider idempotency retention is external; duplicate customer responses require investigation, never automatic adoption by email, external reference or returned conflict ID.

A provider 409 is returned as a sanitized 502 with `automatic_linking: false`; raw response details are not exposed. Successful identity echoes must match the generated request; reliance responses are rejected. Unique provider IDs prevent cross-customer linking.

Live onboarding needs a separate design and explicit real identity collection. This fixture link cannot authorize payment routing or become a real KYC binding.

## Staging rollout

1. Build and test the feature branch. Apply migration 012 only to the pinned staging database using the existing guarded migration procedure. Keep all five financial/demo flags explicitly false.
2. Merge to develop and deploy the staging API with `OZAV_SANDBOX_CUSTOMERS_ENABLED=false` (the default). No main/production deployment is needed.
3. For supervised acceptance, enable `OZAV_SANDBOX_CUSTOMERS_ENABLED=true` only on the staging API. The API requires the pinned staging Auth and database, an OZAV test key and capabilities `customers`, `custody`, `customers:write`. Leave settlement drafts and worker smoke testing disabled.
4. Authenticate as the existing PF test account. GET must return null initially; POST `{}` creates a sandbox fixture customer and local binding. Repeat POST and check the same ID, then GET the same local snapshot. The local profile must remain draft with operations disabled. Check another account cannot read this link and PJ creation is rejected.
5. Disable the flag and redeploy after acceptance. Keep the link for audit and deterministic replay.

The feature has no frontend changes. A frontend integration must forward Authorization and permit this path in its proxy. Display this as a sandbox fixture test, never as completed KYC.
