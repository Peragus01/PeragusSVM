# Customer sandbox Pix

Staging-only resource, separate from immutable record-only purchase references.
`CUSTOMER_SANDBOX_PIX_ENABLED` defaults false. The existing staging database/Auth
pin and sandbox-only client apply. All financial, cosigning, contingency and
simulation flags remain false. No worker, settlement or delivery is started.

Apply migration 023 before enabling the flag in the API service. Quotes and
purchase-intent creation flags can remain false; the Pix path reads the saved
reference. Amount range is BRL 1,000–10,000 for this sandbox rollout.

- `POST /v1/me/sandbox-pix`: strict `{request_id, purchase_intent_id}` UUIDs.
- `GET /v1/me/sandbox-pix/:id`: local saved observation only.
- `POST /v1/me/sandbox-pix/:id/reconcile`: no body; listing/GET only.

All require an authenticated, unsuspended PF customer and return `no-store`.
Unknown/foreign resource reads return 404. No caller-supplied provider IDs, amount,
address, wallet ID or approval is accepted. The database copies the owned quote
and purchase context and rechecks local identity/screening/terms/current wallet
at reservation and claim. A provider customer GET also requires approved/full
with no pending requirements. Capabilities must be sandbox with customers,
liquidity, custody and customers:read/wallets:read/transfers:read/transfers:write.

The provider wallet is discovered by customer-filtered pagination, requiring
exactly one active managed wallet. This Pix funds that custodial wallet, not the
proved Solana address. The latter remains a frozen reference for future delivery;
no on-chain credit to the proved address is claimed. The saved floating quote is
not a rate lock or a delivery estimate: OZAV can reject it, including as expired.
A future production path must handle refreshing and customer acceptance explicitly.

The unique purchase FK and per-customer request ID prevent duplicate charges.
The stable `peragus-pix-<local UUID>` key and metadata are persisted before POST.
An atomic claim permits only one creation attempt, including under concurrency.
HTTP 200 reduced `needs_review` responses retain their transfer ID. HTTP 202,
timeout, malformed response, save failure and all refusals require recovery;
none are retried automatically, and none are reported as a definitive failure.
Repeat the exact original request ID and purchase ID to retrieve the local ID
if the original response was lost; never generate another request ID to retry.

Reconciliation uses GET by persisted ID, or customer-filtered transfer listing
and exact `metadata.peragus_pix_id` match when the ID is unknown, then GET.
It never repeats a creation POST. Listing is bounded to 20 pages and refuses
ambiguous, foreign or incomplete results. An empty listing remains uncertain;
it never releases the unique purchase reservation. If the provider does not
return metadata in listings, recovery needs operator/provider investigation.
Customer, quote, source amount/currency/rail and managed wallet must all match
before instructions are stored/exposed. Compare-and-swap protects overlapping
refreshes from lost updates. Instructions are hidden when expired or the saved
status is no longer awaiting_payment. GET is a saved observation, not real-time
payment status; refresh explicitly before making decisions.

A 201 means verified instructions were saved, 202 means a persisted degraded
response needs reconciliation, 200 on creation means local replay. Errors include
`automatic_retry:false`. Do not pay a sandbox QR with real money or simulate
payment in this step. Keep the flag false after the controlled staging test.

Protocol reference: the supplied OZAV OpenAPI snapshot (`doc ozav(1)`),
POST /transfers (201 full resource, 200 reduced needs_review), GET /transfers,
GET /transfers/{id}, GET /wallets. No external calls are used in automated tests.

## Controlled pay-in confirmation (migration 024)

`CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED` defaults false, separately from Pix
creation. Startup refuses it unless `CUSTOMER_SANDBOX_PIX_ENABLED` is also true.
The financial and old demo/simulation flags remain false. The route is
`POST /v1/me/sandbox-pix/:id/simulate`, authenticated, owned, PF-only, empty body,
no query selectors, with Cache-Control:no-store. Apply 024 before enabling it.

Before the one-shot mutation it GETs the bound provider transfer and verifies
customer, quote, source amount/rail and destination wallet. It saves that verified
observation. Only an unexpired awaiting_payment transfer can be simulated;
unknown IDs, expired/review/failed/cancelled charges and missing bindings cannot.
Already advanced states are returned through GET without another simulation.
Current stored identity, separate screening, accepted terms and wallet evidence
are rechecked, along with live sandbox capabilities and approved/full/no-pending
provider customer status. The final SQL claim rechecks local prerequisites and
instruction expiry against the database clock.

Migration 024 adds the durable simulation_attempted flag and attempt timestamp.
The claim is taken atomically before the provider POST and never reset, including
on timeout, refusal, save failure or process death. The provider method sends at
most one POST, without generic transport retries. Repetitions of the local route
perform GET only once a claim exists. Recovery remains the existing reconcile
endpoint and never repeats a simulation POST. An uncertain attempt may require
manual investigation or a new independent future test; it is never made safe by
clearing a claim.

The simulate response body is deliberately ignored. A subsequent verified
GET is the only evidence saved. `payment_confirmed` requires source_leg.status
completed plus a payment-confirmed-or-later transfer state;
`custody_conversion_completed` additionally requires transfer.status completed
and both legs completed. This refers to simulated credit in the provider-managed
wallet. It does not assert delivery on Solana or to the proved self-custody wallet.
No settlement, worker, RPC, reserve or delivery job is created.

If simulation was attempted but the saved state is still awaiting_payment,
recovery_required stays true, the simulation route returns 202, and Pix
instructions are hidden. Uncertain/provider errors are 503 with automatic_retry
false; query via reconcile before deciding what happened. A successful observed
confirmation returns 200; local repeats include meta.idempotent_replay=true.

For acceptance, first create a new charge for a new saved purchase reference,
then simulate promptly within the Pix validity window, read/reconcile, verify
confirmation evidence and no self-custody delivery, repeat without another POST,
and test foreign-account 404s. Preserve prior expired charges. Disable both
customer sandbox Pix flags after the controlled test. External acceptance remains
pending; automated tests mock OZAV and use the migrations on local PostgreSQL
semantics through PGlite.

Reference: supplied OZAV OpenAPI POST /transfers/{transfer_id}/simulate. It is
test-only, normally advances pay-in then managed-wallet credit and may stop at
payment_confirmed; therefore terminal completion is observed rather than assumed.
