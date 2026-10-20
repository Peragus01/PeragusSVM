# Record-only customer withdrawal requests

This milestone records an owned intended withdrawal against a completed sandbox
conversion. It does not approve, reserve, quote, sign or send anything, and it
creates no settlement or job. The service has only a database repository
dependency: no provider, RPC, signing, balance or queue dependency exists.

Apply migration 025 before enabling CUSTOMER_WITHDRAWAL_REQUESTS_ENABLED on the
staging API (false by default). The pinned staging database/Auth checks still
apply. All financial flags, legacy demo flags, sandbox Pix creation/simulation,
quote and purchase creation flags can remain false. No worker changes, additional
provider scopes, new secrets or dependencies are required.

- POST /v1/me/withdrawal-requests: strict `{request_id, pix_id}` UUIDs; 201 new,
  200 replay, Location points to the local withdrawal request.
- GET /v1/me/withdrawal-requests/:id: owned saved historical record or 404.

Authentication, unsuspended PF, strict 4 KiB JSON, no query selectors and no-store
apply. Client-supplied amounts, wallets, provider IDs, networks and approval flags
are rejected. Another customer's conversion/request is not found.

One INSERT SELECT derives from the same PostgreSQL statement snapshot: own
purchase and quote; own Pix provider customer/quote/transfer and managed wallet;
matching BRL input; transfer and both legs completed; positive USDT target amount;
recorded approved full-mode onboarding without pending requirements; accepted
terms; passing identity checks; clear separate screening; and the currently
proved devnet wallet matching the frozen purchase destination. The withdrawal
amount is copied from the completed transfer's target, not the quote estimate or
the aggregate wallet balance. Fees/net deliverable amount are not evaluated.
Current proof timestamp and evidence revision IDs are retained. Provider freshness
and available balance are not queried by this local record-only action.

Migration 025 has unique Pix, purchase, provider transfer and customer/request
keys. Composite foreign keys prevent a Pix/purchase/customer mismatch. Browser
roles have no grants and RLS is enabled. Response fields expose no provider IDs,
raw payload, proof signatures/messages, Pix code, identity data or secrets.

Same request ID and Pix ID returns the unchanged historical record. Changing the
Pix ID for a request conflicts. Another request for the same Pix conflicts.
Uniqueness resolves concurrent attempts without overwriting a winner. Later
observations or wallet changes do not alter an existing record on replay; this
is retrieval of history, not execution authorization. Auth/suspension gates remain.

The only state is recorded, with record_only=true, manual_approval_required=true,
approved=false initially, withdrawal_started=false, balance_reserved=false,
provider_freshness_evaluated=false, delivery_costs_evaluated=false,
net_delivery_amount=null, job_enqueued=false and operations_enabled=false.
The stored Solana address was proved in test/devnet context; this does not prove
it is suitable for Mainnet or that anyone retained its disposable test key.

Next milestones must separately implement operator identity/MFA/allowlist and
audit reasons, fresh provider/payment/balance checks, fee and Travel Rule data,
network/mint and usable destination validation, one effective withdrawal per
purchase, provider idempotency and uncertain-outcome recovery, plus on-chain
delivery evidence. This record must never itself authorize a send. Existing
sandbox BRL limits are not changed here; production pricing/limits remain separate.

Acceptance: record against the completed approved PF Pix; verify the confirmed
USDT amount and frozen address with all execution markers false; repeat the same
request for 200; try another request ID for a duplicate conflict; read by owner
and verify another customer's 404. Disable the feature after staging validation.
No actual withdrawal or approval should occur in this acceptance test.

Migration 026 adds a separate append-only operator approval audit. Customer
reads/replays reflect approved and approval_recorded_at when a decision exists;
the frozen amount, wallet and proof remain unchanged. Operator ID and reason
stay on the protected admin resource. Approval still never executes a send.
See withdrawal-operator-approvals.md for account separation, allowlist and MFA.

Migration 027 adds an independently gated sandbox execution resource. Readback
now reflects withdrawal_started from its durable attempt claim; this does not
mean verified delivery. Customer views expose sandbox_execution_status and keep
onchain_delivery_verified=false. Economic and approval audit fields remain frozen.
See sandbox-withdrawal-execution.md for the explicit test-only send boundary,
recovery rules and unresolved pilot-slot limitation.
