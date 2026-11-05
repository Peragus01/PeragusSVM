# Record-only customer purchase intents (sandbox)

## Boundary

This is a local immutable-by-API record of an intended BRL → USDT conversion and
an intended wallet destination. It is **not** a payment order, authorization,
executable quote, reserve, Pix charge or completed financial transaction. It never
calls the provider, opens encrypted personal data, invokes an RPC, creates a
settlement, provisions a wallet or publishes a queue job. The existing local
customer status and financial gates are unchanged.

`CUSTOMER_PURCHASE_INTENTS_ENABLED` defaults to false and is enabled only on the
staging API. The executable server requires pinned staging database/Auth. No new
provider/encryption key, scope, worker setting or dependency is needed. Provider
mutation, quote creation, wallet linking and simulation flags may all remain false;
this feature reads previously recorded observations directly.

## Contract

| Route | Request | Result |
| --- | --- | --- |
| POST `/v1/me/purchase-intents` | `{request_id: <UUID>, quote_id: <own local quote UUID>}` | 201 new record / 200 exact replay, Location points to own local intent |
| GET `/v1/me/purchase-intents/:id` | own local intent UUID | Saved record or 404 |

Confirmed Supabase auth, unsuspended PF profile, strict 4 KiB private JSON parsing,
no unknown fields/query selectors, and Cache-Control:no-store. The client cannot
provide the amount, asset, provider customer ID, wallet, state or approval. Body
parse/storage errors do not echo private contents. Another customer's quote or
intent ID is 404. PJ stays outside this PF milestone.

Returned data contains local ID/request ID/quote ID, recorded state and record_only,
source BRL amount, estimated USDT amount, reference rate/public conditions/time,
intended wallet public address with proof network/time, creation time and fixed
markers: environment=test, indicative=true, executable=false,
observation_freshness=not_evaluated, external_delivery_costs_evaluated=false,
funding_started=false, job_enqueued=false and operations_enabled=false.

The destination proof context is solana:devnet while the indicative quote requests
chain=solana. This does not assert a real USDT devnet mint or permission to use the
same evidence for a mainnet transfer. The disposable test keys used in acceptance
are not intended funded customer wallets. Actual Jupiter integration, live wallet
control and the separate custody-to-self-custody delivery leg remain pending.

## Atomic derivation and prerequisites

One SQL INSERT…SELECT reads all prerequisites and derives the record from the same
PostgreSQL statement snapshot. No separate provider eligibility claim is made. It
requires recorded evidence of:

- Own completed quote with matching provider customer/quote IDs, BRL source amount,
  USDT target, positive rate/target, floating rate/null expiry and zero test spread.
- Own linked form-based provider registration with approved status, full mode and
  explicit requirements_pending=false. Missing/unknown requirements block a record.
- The terms session used by that submission, owned by the same customer, in accepted
  state with accepted_at. Expiry after linked submission does not erase historical
  acceptance; this path does not open/cryptographically validate encrypted evidence.
- Completed document, liveness and face checks passing, plus separate completed
  sanctions+PEP screening with result/suggestedDecision clear and zero matches.
  AML not_started on the identity session is not fabricated pass; an explicit
  AML fail/review/pending blocks this record instead of being overridden silently.
- A saved own test/devnet wallet proof. No browser-supplied destination is trusted.

These are recorded sandbox prerequisites, **not** a production compliance policy.
The observation freshness is not evaluated, a provider's current status is not
queried, and no Peragus-specific legal terms acceptance is inferred. Future
financial execution needs independent current eligibility, reviewed terms, limits,
re-pricing, network/destination checks and separate live gates.

Migration 022 adds peragus_customer_purchase_intents with test/record-only/state
constraints, RLS, no public/browser grants, a customer-scoped request ID and a
unique quote ID. A composite foreign key to (quote_id,customer_id) prevents a
cross-owner quote association at database level. Public quote fields and wallet
address/proof time are frozen; audit metadata records registration snapshot,
identity/screening revisions, original terms session ID and wallet proof ID. No
signatures, messages, secret keys, personal form data or raw provider responses
are copied into this table or returned.

## Replay and conflicts

Same own request_id and quote_id returns the original record without changing
its amount/destination, even if observations changed later. It is a historical
read/replay, not re-authorization. Suspension/auth gates still apply. Changing
quote_id for an existing request returns PURCHASE_IDEMPOTENCY_CONFLICT.

One quote can back only one recorded intent. Reusing it under another request ID
returns PURCHASE_QUOTE_ALREADY_RECORDED. Competing inserts use database uniqueness
and never overwrite a winner. Different customers may independently use the same
request UUID. Failure before a local insert is safe to retry; no external side
effect exists. New records with missing/rejected/uncertain prerequisites return
PURCHASE_PREREQUISITES_NOT_RECORDED (409); the frontend can use the read-only
onboarding overview to display the stored stages.

The only API state is recorded; there is no update/delete/execute/fund endpoint.
The worker never reads this table. Future payment orchestration must be an explicit
new design and must not treat these records as transferable payment authority.

## Rollout and acceptance

1. Build and apply migration 022 on pinned staging before merging into develop.
2. Deploy the API. Set CUSTOMER_WALLET_LINKING_ENABLED=false and keep quotes,
   other provider mutations, simulations and all financial flags false.
3. Temporarily enable CUSTOMER_PURCHASE_INTENTS_ENABLED=true only on the API.
   Keep customer webhook and read-only overview active.
4. With the second approved PF, reference its existing local sandbox quote.
   Verify 201, source/estimate matching that quote, derived wallet and all execution
   markers false. Repeat with same request/quote for 200 and unchanged ID/destination.
5. Read own intent, test another account's 404, strict body rejection and quote reuse
   conflict under another request ID. Verify no settlement or job was created.
6. Disable the purchase-intent flag after acceptance and preserve audit records.

Automated coverage includes same-statement prerequisites, frozen metadata,
request/quote uniqueness, concurrent records, owner isolation, provider/identity/
screening/terms/wallet failures, malformed quote evidence, strict parsing,
auth/PJ/suspension/feature gates, database ownership/record-only constraints and RLS.
External API acceptance is pending until the deployed route is tested in staging.
