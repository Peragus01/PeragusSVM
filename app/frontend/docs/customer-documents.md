# Customer document integration

The authenticated PF onboarding screen now includes document requirements, synthetic file selection, upload and receipt tracking after the customer submission is linked. It uses the backend contract introduced by PR #61; no frontend flag bypasses the backend's default-disabled feature.

## Contract and safety

- Same-origin `/api/v1/me/onboarding/documents` bridge permits only the exact list, requirements, upload, own record and refresh routes, with GET/POST methods matching the backend.
- Upload is raw JPEG/PNG (PDF only for proof of address). Browser/proxy limit is intentionally **4 MiB**, below the backend's 5 MiB limit. File extensions alone are not trusted; backend validation remains authoritative.
- Authorization and the four upload headers are forwarded explicitly. Cookies, filenames, client-selected destination URLs and arbitrary headers are not forwarded. Requests and responses are bounded, time limited, uncached and refuse redirects.
- File selection and an explicit synthetic-data checkbox are required for each upload. Only provider-requested supported document types can be selected. Unknown requirements, no requirements, and unsupported requirements have distinct states; none implies KYC approval.
- Upload records, selected files and request UUIDs are not saved to browser storage. No provider URL is exposed. Account changes discard local state and abort in-flight work. A synchronous lock blocks duplicate clicks.
- After a failed/ambiguous upload, the form stays blocked for the current account view. Update the list and consult the saved record; refresh is a POST at the application boundary but performs GET-only provider reconciliation. No automatic upload retry occurs. If no record appears, contact support rather than uploading again. Backend durable claims remain the ultimate replay guard across reloads and sessions.
- Receipt is shown as “Arquivo recebido — análise pendente”; no document response changes identity approval or enables operations. No automatic emails, financial calls or production credentials are used by this integration.

## Staging acceptance (separate rollout)

1. Merge backend PR #61 into `develop` and this frontend change into `feat/frontend-mvp-integration`. Keep `CUSTOMER_DOCUMENTS_ENABLED=false` during deployment.
2. Use the backend's existing migration runner to apply migration 038 to the pinned staging database; follow `app/backend/docs/integration/customer-documents.md`. Do not paste SQL into production or rename existing migrations.
3. Confirm test-key customer read/write capability, linked full-mode synthetic customer, configured upload origin and all existing startup guards. Only then enable the feature in staging. No live key is needed for local UI/contract tests.
4. With an authorized synthetic PF test account, inspect requirements, upload a synthetic JPEG/PNG, verify receipt/hash reconciliation, and check that identity/financial authorization remain unchanged. Never send real identity documents to this test environment.
5. Verify a second account cannot see or refresh the first account's records. Check disabled feature, unsupported liveness, empty/unknown requirements, size/MIME rejection, double click, ambiguous upload and GET-only recovery.

Local tests mock both the API and upload transport. They do not establish that OZAV accepts document uploads with the account's sandbox key. Provider origin/capability and external synthetic acceptance remain pending; a provider limitation must not be bypassed with a live key or approval simulation.
