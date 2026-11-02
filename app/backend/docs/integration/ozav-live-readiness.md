# Live pilot: provider contract and first capability gate

Contract inspected on 2026-11-01: https://developers.ozav.io/openapi.json, OZAV API v2.0.0; server https://developers.ozav.io/v2. The normalized downloaded JSON SHA-256 was `d2a46040a623230f18da4863c56e623ef1c6cee5359b382853eaee261b1675b6`. This is a reference snapshot hash, not a deployment or provider-response signature.

## Contract findings

| Stage | Current public contract | Peragus gap |
| --- | --- | --- |
| Account access | GET /capabilities reports environment, entitlements, scopes and feature readiness. Test and live share the origin; key prefix selects environment. | Current runtime adapters deliberately accept test only. Inspect live separately before implementing an environment-aware path. |
| Full KYC | POST /verifications can return no hosted URL. Without hosted capture it can return in_progress/review and pending_documents, directing uploads through customer documents. Test never starts a real identity check. | The existing parser rejects non-null session_url and drops pending_documents; the service always exposes session_url:null. A live key alone cannot complete this UI. |
| Documents | POST /customers/{customer_id}/documents declares a document and returns a short-lived upload_url for PUT bytes. | Implement authenticated ownership, document categories, size/MIME limits, private upload handling, URL validation/redaction, status refresh and explicit capture UX. Do not put real documents into the test journey. |
| Quote | Quotes are indicative/floating. Send target.chain for stablecoin delivery; source.chain for stablecoin sources. Network cost can otherwise be absent. | Explicitly price Solana, preserve rate/spread/deductions, disclose net/cost limitations, and revalidate at acceptance. No invented zero delivery fee. |
| Pix conversion | POST /transfers can fund a customer wallet through fiat_payment. | Replace the record-only journey with a separately reviewed live order/payment state machine; preserve idempotency and payment reconciliation. |
| External delivery | Managed-wallet sends use POST /wallets/{wallet_id}/transfers or POST /transfers; provider signs/broadcasts; external sends require applicable Travel Rule checks. Wallet sends require Idempotency-Key. | Explicit chain/USDT/destination binding, custody verification, complete fee policy, unknown-outcome recovery and independent destination evidence. Conversion completion alone is not delivery. |
| Solana program | Peragus's current Anchor configuration and proof flow are Devnet/Token-2022. | Verify mainnet token/program compatibility. An OZAV managed send does not establish that the Peragus two-leg program runs. Do not silently equate the two delivery paths. |

The provider-wide contract does not prove these features are enabled for this account. Beta is not general availability. Customer approval, identity completion, wallet control and financial eligibility remain separate gates. Commercial permission reported by the owner is not being re-requested here; the missing evidence is technical configuration and capability.

## Safe account inspection

Run `node scripts/ozav-live-readiness.mjs` from app/backend after setting `OZAV_READINESS_API_KEY` through the local/private environment. Do not paste the key into chat, command history or a command argument. The script defaults to expected environment `live`; set `OZAV_READINESS_EXPECTED_ENVIRONMENT=test` only to inspect a test key deliberately.

The variable is deliberately separate from the running API's OZAV_API_KEY. Do not replace staging credentials or flip financial flags to run it. The diagnostic is not imported by the API, the worker, or startup scripts. It makes exactly one GET /v2/capabilities to the fixed provider hostname, rejects redirects and oversized/malformed data, and prints selected capability metadata rather than the raw response or errors. It never connects to the database, creates records, uploads files, quotes, verifies identity, signs or transfers funds. It always reports financial_operations_authorized:false.

The missing-scope checklist is an integration baseline, not sufficient authorization and not a demand to issue a broadly writable diagnostic key. Any valid key can call capabilities; use the existing securely held key to inspect its actual grants. Review additional document/wallet/Travel Rule permissions against the selected live flow before implementation. Do not interpret a feature labeled live as proof of available balance, customer eligibility, asset route, priced fees or capture availability.

## Execution order

1. Read account capabilities with this diagnostic; record only the sanitized report.
2. Choose the actual full-KYC capture path: approved hosted origin when offered, otherwise controlled document upload and required steps. Preserve pending status until provider evidence is complete.
3. Implement wallet proof on the correct network and verify the chosen delivery/token/custody contract.
4. Implement explicit-chain quotes and final cost/acceptance behavior.
5. Connect Pix order/payment, conversion and external delivery as separately reconciled states.
6. Run an explicitly authorized low-value pilot and verify the destination before declaring delivery.

No live capability call or external write was performed while developing this diagnostic. Live credentials remain unavailable to this workspace, so account-specific readiness remains unverified.
