# Customer indicative BRL → USDT quotes (sandbox)

## Product boundary

This milestone estimates BRL → USDT conversion for an authenticated own PF
customer. It does not create Pix, accept/pay/execute a quote, create a settlement,
provision a wallet, enqueue a worker job or send USDT. All existing financial and
demo flags stay false. The feature is independent of wallet linking and onboarding
mutation flags, which may remain false.

The documented provider quote is floating/indicative with expires_at=null. Null
is not a forever-valid fixed price; a later execution would reprice. Sandbox quotes
are non-executable. The returned target amount is not a promise of USDT delivered
to an external wallet. pricing_scope=conversion_estimate and
external_delivery_costs_evaluated=false explicitly preserve that boundary. The
separate custody-to-self-custody delivery leg remains unimplemented here.

## Configuration and HTTP

`CUSTOMER_QUOTES_ENABLED` defaults to false, only on staging API. Enabling it
requires pinned staging database/Auth, a test provider key, and disabled financial
flags. Runtime provider capabilities must include customers/liquidity and
customers:read / quotes:write. No new secret or worker variable is needed.
Migration 021 creates the test-only quote intent/observation table with RLS and no
public/anon/authenticated grants.

| Route | Request | Response |
| --- | --- | --- |
| POST `/v1/me/quotes` | `{request_id: <UUID>, source_amount_brl: "500.00"}` | 201 new quote / 200 saved replay, Location pointing to local quote ID |
| GET `/v1/me/quotes/:id` | own local UUID | 200 saved observation / 404 absent or another customer's ID |

Existing confirmed-email auth and PF/suspension gates apply. Only strings are
accepted for amounts: no numbers, exponent, leading zeros, separators or >2
fractional digits. Normalize to two BRL decimals with BigInt, not floating point.
The sandbox input range is 0.01–10000.00 BRL per indicative request; this is an MVP
input bound, **not** a production transaction, compliance or customer limit.

The client cannot choose a provider customer ID, wallet, asset, rail, chain or
spread. The server derives the customer from its own linked form-based sandbox
registration and freshly checks provider status=approved, mode=full, and
requirements_pending=false before creating a new quote. This is a conservative
quote-access check, not a financial authorization policy or a completed real KYC.
No wallet proof is required just to see an indicative price.

Fixed external body: customer_id from that binding; source BRL normalized amount;
target USDT/solana; source_rail=pix; spread_bps=0 explicitly, so a configured default
additional spread is not silently applied. This zero-spread setting is for this
sandbox milestone, not Peragus's final commercial pricing.

Private JSON parsing caps requests at 4 KiB and does not echo malformed contents.
Unknown body/query fields are rejected. Every response has Cache-Control:no-store.
No provider bodies, request bodies or amounts are logged by these handlers.

## Ownership, attempts and recovery

Persist a unique (customer_id,request_id) intent with frozen normalized amount and
provider customer ID. Same ID/body replays a saved quote without external calls;
changing the amount/binding conflicts. Different customers may use the same
request_id independently. Local UUID and provider quote ID are unique, separate
identifiers; only the local UUID is exposed in the API.

Claim create_attempted atomically before the provider POST. Only one racing caller
may send. The provider's POST /quotes documents no idempotency key and no list
endpoint for recovering an unknown created quote, so this path sends no such key
and does not assume retry safety. Transport attempts are limited to one.

After a provider timeout, malformed response or HTTP failure, return sanitized
QUOTE_PROVIDER_UNAVAILABLE with the own local quote_id, provider_http_status and
automatic_retry=false. The intent is retained; repeating the same request returns
QUOTE_RECOVERY_REQUIRED rather than another POST. A crash after claiming but before
sending has the same conservative recovery requirement. A successful provider
response followed by database failure likewise cannot silently repeat creation.
No operator reset, guessed quote ID, import or approval endpoint is exposed.

GET shows state=uncertain and null quote fields for a reserved, unconfirmed intent.
It cannot distinguish an in-flight call from an interrupted one. If a local error
did not expose the UUID, repeating the same request returns the owned recovery ID.
Investigate/reconcile before an intentional new quote with a new request_id; there
is no automated bypass that generates another request ID after an error.

## Response and pricing semantics

Return local ID/request ID, source amount/currency, target amount/currency/requested
chain, rate/rate_type, public exchange_conditions, expires_at, provider quoted_at,
local recorded_at, and fixed test/indicative/non-executable markers. Replay/GET
returns that recorded quote; it does not refresh the market or claim freshness.
A client wanting a deliberate new estimate uses a new request_id.

Validate provider customer, amounts, currency pair, floating type, null expiry,
zero spread and network if echoed. Reject via/legs (composite routes), locked or
zero rates, wrong customer/network/currency/source amount and invalid decimal
formats. All decimal values remain strings. Public rate_without_spread, if present,
must equal the zero-spread rate numerically. amount_deducted is preserved as a
source-currency string or null; it is not inferred zero or called total fees.
Reject a deduction that consumes/exceeds the entire source amount. Provider
network cost/margin analytics are not exposed. Target amount stays the provider's
indicative value; this path does not reconstruct opaque pricing or compute a
second self-custody delivery amount.

Only the sanitized quote observation is persisted (no raw provider fields, margin
analytics or personal form data). Old quotes remain historical non-executable
observations even if customer status changes later. Future financial execution
must independently recheck eligibility, destination, limits, terms and current
pricing; it must never accept this sandbox record as permission to pay.

## Rollout and acceptance

Apply migration 021 with the pinned staging guard before merge. Merge into develop,
deploy API and temporarily enable CUSTOMER_QUOTES_ENABLED. Keep wallet linking,
provider mutation, verification simulation and financial flags false; read-only
overview and customer webhook may remain active.

Use the second PF (approved sandbox provider customer) to create one small quote.
Expect indicative=true, executable=false, floating/null expiry, explicit zero
additional spread, operations_enabled=false and no Pix instructions. Repeat the
same request ID/body and verify the same local quote without a new provider call.
Read the own local ID, test foreign-account 404 and changed-amount 409. Rejected
provider-customer access must not create a quote. Disable the quote feature after
acceptance. No money or real customer data is used.

Automated checks cover exact decimal normalization, request ownership/idempotency,
CAS claiming, uncertain-outcome safety, scoped provider access, sanitized quote
validation, private responses, authentication/PF/suspension gates, RLS and absence
of wallet/settlement side effects. External staging acceptance is pending until the
new deployed route is exercised. The financial flow and frontend quote UX remain
separate milestones.
