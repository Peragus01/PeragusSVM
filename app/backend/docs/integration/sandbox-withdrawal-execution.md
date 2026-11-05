# Sandbox-only approved withdrawal execution

This milestone calls OZAV POST /transfers in test, using source=wallet and
destination=crypto_address on explicit Solana. It is the first external send
attempt in the customer purchase journey. No production key is accepted, no
Mainnet RPC is called, and provider completion is never displayed as verified
on-chain delivery. The disposable devnet proof remains sandbox context only.

Apply migration 027 before merge/deploy: customer and approval reads now join
execution evidence to reflect withdrawal_started correctly. The table has
sandbox/Solana constraints, composite approval/withdrawal/customer FKs, one row
per approval/withdrawal, stable per-execution idempotency key, unique provider ID,
RLS and revoked browser grants. No raw provider payload or Travel Rule PII is
stored. Only explicitly parsed non-PII observations are persisted.

SANDBOX_WITHDRAWAL_EXECUTION_ENABLED defaults false. Enabling it requires the
existing explicit WITHDRAWAL_OPERATOR_USER_IDS allowlist and a sandbox OZAV key,
plus pinned staging database and Auth. Financial, cosigning, contingency,
legacy demo, Pix, simulation and quote flags stay false. Approval creation may
remain disabled: execution independently requires the stored approval and
allowlisted aal2 operator. No worker or dependency change is needed.

Operator routes (separate account with no customer profile; verified email,
server-validated bearer, allowlist and aal2 MFA):

- POST /v1/admin/withdrawal-requests/:id/execution with strict
  {request_id: UUID, confirmation: "SANDBOX_ONLY"}.
- GET the same resource reads saved state only.
- POST /v1/admin/withdrawal-requests/:id/execution/reconcile, no body, reads OZAV
  and updates saved evidence only. It never repeats a send.

The backend takes amount and destination from the approved completed conversion,
not an input address, estimate or aggregate balance. Before a first attempt it
rechecks current local KYC/screening/terms/wallet/conversion bindings; verifies
that the original approving operator is still allowlisted; GETs fresh funding
transfer evidence; requires approved/full/active provider customer with explicit
empty requirements; reads the bound active managed wallet and available USDT;
and refuses insufficient/ambiguous balance. The source amount must match the
settled conversion exactly. The address must be a valid on-curve Solana key.

Travel Rule originator/beneficiary fields are built in server memory from that
provider customer's validated name, valid Brazilian CPF and structured address.
Beneficiary is that same customer, self_custodied, attested at the frozen proof
time. These fields are sent only to OZAV, never accepted from the browser,
persisted in the execution table or echoed in responses/errors/logs.

Reservation rechecks local evidence in one INSERT SELECT and acquires the single
unresolved pilot slot before any send. Atomic claim precedes the provider POST.
Only one POST is attempted per withdrawal, with peragus-send-<execution UUID> and
correlation metadata. Different request IDs cannot duplicate a withdrawal;
concurrent requests race on database uniqueness/claim, not process memory.

All 202, HTTP refusal, timeout, malformed response, save failure and process
restart outcomes keep the claim and pilot slot. A normal 201 or reduced 200 ID
is bound before a fresh GET is parsed as evidence. Repeat the original local
request to recover its ID/status, not a new key. Reconciliation uses known ID or
complete customer-filtered metadata listing, then GET. Empty/incomplete/ambiguous
listing never releases the claim or authorizes another POST. Operator diagnostics
expose only sanitized provider HTTP status and machine code, never message/PII.

The observed send must match customer, source wallet, Solana destination, USDT
currency and exact source amount. Target amount must be positive and no greater
than source; the returned target is recorded separately, never promised equal
to the gross amount. Settlement network references must be consistent. Private
Travel Rule fields and unrelated response data are discarded. CAS prevents lost
updates, and terminal observations cannot regress.

Important limits of this sandbox milestone:

- No fee preview is offered by this path. delivery_costs_preflight_evaluated=false;
  production must settle fee acceptance and net-delivery policy first.
- provider_completed is provider evidence only; onchain_delivery_verified=false
  and mainnet_execution=false even if a transaction reference is supplied.
- One unresolved pilot slot remains held even after provider completion/failure.
  This milestone has NO release/reset endpoint. Do not clear it by SQL or create
  a new key after an uncertain outcome. Controlled closure/delivery verification
  is a separate milestone before more sends or a real-money pilot.
- Funding available in test is simulated; native mint/signature/finality checks
  for real delivery are not implemented here. No fallback hot wallet, custom
  program, alternate chain or production key is used.

Acceptance: enable only this feature for one already approved sandbox request,
login as the dedicated MFA operator, execute once, GET/reconcile, repeat with
same request, and verify sanitized evidence plus no second provider POST or false
on-chain delivery. Test MFA/customer/strict input gates. Preserve the audit and
claim, then disable the execution flag. All external sandbox acceptance remains
pending until the deployed code is tested.
