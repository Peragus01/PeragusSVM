# Invited customer journey contracts

## Scope and current boundary

This change extends the existing closed PF pilot without enabling financial operations or changing production configuration. It was tested together with the frontend journey on top of `develop` (`f99dea7`) and the approved frontend integration branch (`209b509`, PR #47). Backend and frontend changes are delivered as dependent PRs to their respective branches.

The current provider adapters remain pinned to test capabilities. The frontend cannot select an environment or convert a test record into a live order. Commercial approval previously reported by the owner is separate from the technical live contracts still required here.

## Invitations before Auth signup — migration 034

Existing UUID-bound invitations still work. Operators can now issue an invitation using exactly one of `target_user_id` or `target_email`:

```json
{
  "request_id": "OPERATOR_GENERATED_UUID",
  "target_email": "synthetic-participant@example.test",
  "expires_in_hours": 24,
  "reason": "Controlled synthetic participant admission."
}
```

Use the existing `POST /v1/admin/pilot-invites` from the separate operator entry point with verified allowlist membership and AAL2. The existing five-slot policy, one-use code, TTL, revocation, operator/customer account separation and issuance replay behavior are unchanged. The raw code is returned once, never stored or recoverable from the backend.

New API-only optional configuration: `PILOT_INVITE_EMAIL_HASH_KEY`, exactly 32 random bytes encoded as 64 hex characters. Store it as a Railway secret, never a VITE variable. Email targets use HMAC-SHA256 with this key; no raw email is added to the invite table. Keep the key stable and backed up with the existing secret procedure: rotating it invalidates outstanding email-bound codes. Without it, old UUID invitations continue working but email issuance and pre-registration validation return a disabled error.

`POST /registration/invite/check` accepts exactly `{code,email}`. It is the only unauthenticated new route. It validates availability without consuming or reserving a code or creating an Auth user/profile. Unavailable, expired, revoked and mismatched codes share a non-enumerating response. The UI performs this check before public Supabase signup, asks for email confirmation, and redeems after authenticated login. Confirmation redirect/site URLs and email delivery remain Supabase configuration; no service-role credential is required or introduced.

A direct call to public Supabase signup still cannot create an admitted Peragus customer. The runtime with a database continues requiring invite redemption for new profiles, even when the invite flag is off. Auth accounts without profiles may only access the identity/admission resources; product data and financial resources remain gated.

`POST /v1/me/pilot-invite/redeem` still accepts `{request_id,code,display_name}`. The verified email from the authenticator, not a browser-supplied user/email, is matched. One SQL statement locks the invitation and slot, creates the PF profile, binds the email invitation to the verified user UUID, consumes it, and occupies the slot. Failure rolls back the whole statement. A retry with the same identifiers returns the existing profile. Signup failure or an interrupted email-confirmation step does not consume the invitation. No approval, KYC or payment is inferred from redemption.

Public validation uses the existing PostgreSQL throttling mechanism: 10 checks per ingress address per 15 minutes. The address is hashed into a rate-limit actor UUID; arbitrary forwarded headers are not trusted. With the same-origin proxy, several people can share an ingress budget. This is intentionally conservative for the five-person pilot; production needs trusted gateway-level abuse controls and cleanup/retention of rate-limit rows. Supabase signup protections/rate limits must also remain enabled.

## Target-side indicative quotes — migration 035

`POST /v1/me/quotes` now accepts exactly one amount alongside `request_id`:

- `source_amount_brl`: existing normalized BRL amount, at most 10,000.00.
- `target_amount_usdt`: positive decimal with up to six places, normalized with BigInt.

The server sends `source.amount` **or** `target.amount` to OZAV's documented `/quotes` operation. BRL, USDT, Solana, Pix rail, customer binding and zero additional test spread are still derived by the backend. There is no client-side inversion, spread selection or executable-price calculation.

A target request is reserved with its immutable requested target and a zero source placeholder **before** the provider POST. Zero is allowed only while no provider quote/observation exists. The unresolved public source amount is null, never a zero-price offer. A successful observation must match customer, target, network/type and existing source bounds, then atomically replaces the source placeholder with the validated returned BRL. Requested side/amount conflicts on a reused request ID are rejected.

The provider POST is still claimed once. Timeout, malformed response or save failure cannot cause automatic recreation. GET and explicit same-key recovery retain the existing behavior. `executable=false`, `environment=test`, `external_delivery_costs_evaluated=false` and `operations_enabled=false` remain mandatory.

`GET /v1/me/purchase-capabilities` returns authenticated, server-derived availability for quote, record-only confirmation and test Pix, plus explicit test/non-financial markers. These booleans are feature availability, not a replacement for each operation's ownership, KYC, terms, limits and wallet checks. No new enablement flag was added.

## Editable account data — migration 036

`PATCH /v1/me/customer` accepts exactly `{display_name,expected_display_name}`. It updates only the authenticated, unsuspended customer's **local display nickname** using an optimistic comparison. It never changes legal name, tax ID, email, provider customer data, KYC, role, limits or financial permissions.

The update and an audit insertion are atomic. Audit rows contain actor/customer IDs, field name and time, without old/new personal values. RLS/revocation and an immutable audit trigger protect the new table. Concurrent stale edits return `PROFILE_VERSION_CONFLICT`. Sensitive JSON uses a bounded private parser. The server response must succeed before the client reports success and reloads identity.

Verified personal data and email remain read-only in this release. A future legal-data update needs provider-supported revalidation; secure email changes need their own confirmed Auth flow. The UI does not pretend these fields were synchronized with OZAV.

## Existing resources integrated by the frontend

- Encrypted individual draft GET/PUT with `expected_version`.
- Terms creation/read/explicit acceptance and renewal.
- Frozen onboarding submission and explicit refresh.
- Verification creation/read/refresh and independent screening creation/read/refresh.
- Wallet challenge + exact message signing + confirmation; existing immutable Devnet destination binding.
- Quote/record-only creation and owned GET recovery.
- Test Pix creation, read and read-only provider reconciliation; no simulation endpoint is exposed through the customer proxy.

The backend's existing purchase prerequisites remain authoritative. A local profile in draft is not treated as an identity rejection or an approval.

## Provider limitations verified against current documentation

Reference: [OZAV OpenAPI](https://developers.ozav.io/openapi.json), `POST /quotes`, `Quote`, `ExchangeConditions` and `Verification` schemas, consulted 2026-10-29.

The official schema documents that test keys never produce a hosted verification `session_url`. A session can exist in pending state without capture. The frontend therefore exposes mandatory creation/continuation/status steps but cannot complete real document capture in test mode, invent a session URL, or approve a customer. No simulation button is added. Live hosted capture additionally depends on OZAV's platform-wide capture availability; a live credential alone is insufficient.

The quoted USDT amount is an indicative conversion estimate, not guaranteed net self-custody delivery. The reported BRL deduction is shown separately. Unknown delivery fees and net USDT remain unknown, never zero. No extra deduction or synthetic final fee is computed.

## Validation and staging procedure

- Backend build/typecheck; 640 tests across 65 files passed, including legacy admission, auth/operator separation, quotes, ownership, reconciliation and new email concurrency/target-quote/profile-audit cases.
- Frontend validation and combined synthetic browser acceptance are documented in `app/frontend/docs/invited-customer-journey.md`.
- No external OZAV calls, real Auth signup, real documents, staging writes or payments were performed by acceptance tests.

Deployment order:

1. Review backend changes against develop and take the normal staging backup.
2. Apply **034, 035 and 036 in order** to staging before deploying this backend. Do not apply migrations here to production.
3. Deploy Railway with existing financial/simulation flags off. Add the email HMAC key only on the API when preparing controlled email-invite acceptance. No worker setting or browser secret is required.
4. Deploy the dependent frontend to Vercel Preview with its normal public Auth configuration and same-origin API proxy.
5. First verify disabled-feature responses, existing customers/history, direct-signup admission rejection and customer denial on operator APIs.
6. Only in a separately authorized synthetic staging acceptance, enable the specific non-production onboarding/invitation/quote/wallet resources required by the test. Test Pix is a separate explicit action and flag. Never enable simulation, withdrawals or live financial operations as part of this deploy.
7. Issue a synthetic email-bound code, create/confirm Auth, redeem/replay and resume onboarding; check that no duplicate profile or verification is created. Validate automatic BRL/USDT estimates, destination proof, test review and nickname editing. Restore temporary flags afterwards.

Before live use, implement/validate live onboarding capture, secure personal-data changes where needed, complete fee disclosure, payment eligibility, mainnet ownership/delivery and independent transaction evidence. This change does not remove those requirements.
