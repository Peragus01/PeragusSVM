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
