# Sandbox withdrawal recovery with new sends disabled

Before this change, GET execution and POST reconcile were gated by the same service as creating a sandbox send. Introduce `SANDBOX_WITHDRAWAL_RECOVERY_ENABLED=false` (default) so existing execution evidence can be read and refreshed while `SANDBOX_WITHDRAWAL_EXECUTION_ENABLED=false`.

With recovery enabled:

- `GET /v1/admin/withdrawal-requests/:id/execution` reads the existing local execution.
- `POST /v1/admin/withdrawal-requests/:id/execution/reconcile` accepts no body/query and performs provider GET/list only, then binds/persists validated evidence.
- `POST /v1/admin/withdrawal-requests/:id/execution` remains disabled unless the independent execution flag is enabled.

The existing dedicated-account, allowlist and verified aal2 requirements remain. The recovery flag requires the pinned staging database/Auth project, a test OZAV key, an explicit operator allowlist and the existing financial/demo write guards. Set it on the staging API only; no worker change is required. No migration.

Recovery service capabilities are restricted to repository read/bind/save and provider find/transfer. The provider facade is frozen and exposes no send operation; live keys are rejected before I/O. An absent execution returns 404 and is never reserved by recovery. An unattempted reservation is read without contacting the provider. Unknown responses stay unknown when listing finds nothing; no claim resets, key rotation, automatic POST retries or pilot-slot releases occur. Existing provider ownership/amount/destination/network validation and observation persistence rules apply. Unknown net target remains null.

This is not a refund path and does not reverse a completed conversion or delivery. The supplied OZAV API document has no generic refund endpoint for this transfer flow; refund conditions, fees and operational procedure still require agreement with OZAV.

If recovery is disabled, execution-service behavior remains unchanged: existing execution reads/reconciliation still work when the execution flag itself is enabled. Both flags default false. Audit and queue database-only reads remain available independently.

Staging acceptance after deployment: keep execution and approvals false, enable only recovery. As dedicated MFA operator, GET and reconcile the known completed withdrawal; expect provider_completed and unknown target. Confirm POST execution returns SANDBOX_WITHDRAWAL_EXECUTION_DISABLED without creating another send. Customer/no-MFA accounts remain blocked. Disable recovery again after acceptance.
