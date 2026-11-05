# Customer update webhooks — sandbox

## Scope and trust boundaries

`POST /webhooks/customer-updates` receives signed provider notifications. It is outside `/v1` and uses signature authentication, not a Supabase bearer token. Existing customer routes retain bearer authentication. This receiver only refreshes **existing linked PF sandbox customers**: diagnostic fixtures and, after migration 017, form-based synthetic registrations. It never creates or adopts a customer, updates local approval, enqueues financial work or enables operations.

Subscribe to `customer.updated`. Other well-formed sandbox event types, including `webhook.test`, are acknowledged and recorded as ignored. This milestone does not process verification, requirement, transfer or payment event types. A `customer.updated` without a valid `data.customer.id` is refused. An unlinked customer ID is acknowledged as ignored; it cannot be adopted by email, external reference or event contents. If an event arrives before fixture binding completes, use the existing explicit refresh afterwards to reconcile it.

The event body is a notification, never the source of truth for customer status. After resolving the ID against an existing local test binding, the receiver calls capabilities with the test key and re-fetches the current customer using the existing identity checks and sanitized snapshot parser. Out-of-order events therefore cause a fresh observation instead of rolling status back to their embedded snapshot. Status `approved` may coexist with outstanding requirements. Local approval and financial authorization remain independent and disabled.

## Signature and envelope

Send `Content-Type: application/json`. The route has a private raw-buffer parser and a 64 KiB body limit; ordinary JSON parsers elsewhere are unchanged. The original bytes are verified before parsing JSON.

- `X-OZAV-Signature`: `t=<Unix seconds>,v1=<lowercase SHA-256 hex>`.
- HMAC key: the **entire** endpoint secret as returned, including `ozav_whsec_`.
- Signed input: the exact timestamp string, `.`, then the original request bytes.
- Signature comparison uses `timingSafeEqual`. Delivery time must be within 300 seconds in either direction. Keep the server clock synchronized. Event `created_at` is not used for this window: an old event may have a new delivery signature.
- `X-OZAV-Event-ID` must match the envelope `id` (`ozav_evt_...`).
- The envelope must include `object: event`, a machine-readable type, RFC 3339 `created_at`, `data`, and boolean `livemode`.

A signed live event gets HTTP 200 with `result: ignored_environment`, without database or provider calls. Missing `livemode` is rejected rather than inferred from an endpoint label. Legacy delivery recovery through the provider events API is not implemented; use a newly registered test-key endpoint for this rollout. The delivery-ID header is not an idempotency key.

## Atomic deduplication and failure behavior

Migration 014 adds `peragus_customer_webhook_events`, with an event-ID primary key, SHA-256 hash of original bytes, event type, test environment, outcome and timestamps. RLS is enabled and browser-role grants revoked. No raw bodies, signature headers, legal identity fields or documents are stored.

The PostgreSQL transaction inserts the event receipt first. A concurrent delivery with the same ID waits on the unique constraint or gets a retryable lock-timeout response. An already committed matching ID/hash returns `duplicate` without another provider call. Reusing an ID with a different hash returns 409 and changes nothing.

For a linked customer, the transaction locks its binding before reading the provider and uses the snapshot repository's version comparison. Snapshot update and final event disposition commit together. A provider error, malformed response, lock timeout or persistence failure rolls both back and returns 503, so the sender can retry. There is no success acknowledgement before commit. Failed attempts are not retained as successful receipts. Same-customer event reads are serialized; a concurrent explicit refresh may receive a version conflict and can retry.

This is a synchronous, low-volume staging receiver, not a background queue: the connection is held during the provider reads. Its client makes one attempt with a 3-second timeout per read; lock timeout is 1.5 seconds and SQL statement timeout is 8 seconds. A burst or provider rate limit may cause 503 and sender retries. A queued inbox/worker and automatic retry exhaustion recovery remain future work. Do not use this implementation as payment authorization.

| HTTP/result | Meaning |
| --- | --- |
| 200 `processed` | Current provider snapshot and receipt committed |
| 200 `duplicate` | Receipt already committed; no repeat refresh |
| 200 `ignored` | Signed sandbox test/unsupported/unlinked event recorded, no refresh |
| 200 `ignored_environment` | Signed live event intentionally excluded |
| 401 | Signature missing, invalid, expired or too far in the future |
| 400 | Invalid JSON/envelope, absent environment or mismatched event header |
| 409 | Conflicting event ID/body, or malformed customer-update target |
| 413 | Body exceeds 64 KiB |
| 415 | Unsupported content type |
| 503 | Feature disabled or processing failed; sender should retry |

Only fixed log fields (event ID, outcome or retry-required) are written by the receiver. Exceptions and provider response bodies are not logged. The deployed logger redacts the signature header in addition to bearer/cookie headers. Startup emits `customer_webhook_receiver_configured` with the enabled boolean only.

## Configuration and staging rollout

Defaults: `CUSTOMER_WEBHOOKS_ENABLED=false`; `CUSTOMER_WEBHOOK_SECRET` absent. When enabled, the executable API requires the pinned staging database/Auth project, all financial/demo flags disabled, an existing test API key, and the full endpoint signing secret. The provider test key must permit `customers:read`. The receiver's flag is separate from `OZAV_SANDBOX_CUSTOMERS_ENABLED`: notifications can refresh existing links while user-triggered fixture creation/refresh remains disabled. Configure these on the **staging API only**, not the worker.

1. Build the branch and apply migration 014 to the pinned staging database with the existing guarded migration procedure. Merge to develop and deploy the staging API with the receiver disabled. Do not change main or production.
2. Register a provider endpoint using the **test** API key, URL `https://peragussvm-staging.up.railway.app/webhooks/customer-updates`, subscription `customer.updated`. Registration requires `webhooks:write` and any provider entitlement gate; those permissions have not yet been verified. Documentation examples show test keys even where availability metadata says live: verify sandbox registration without substituting a live key. Check existing endpoints before retrying registration, because a network failure can hide a successful create.
3. The signing secret is returned once on creation/rotation. Store it directly in Railway as `CUSTOMER_WEBHOOK_SECRET`; never paste it into chat, PRs or committed files. Keep the complete prefix. The secret is different from the API key. Set `CUSTOMER_WEBHOOKS_ENABLED=true` and deploy. Confirm startup readiness and active deployment.
4. Send the provider's endpoint test event. Expect a signed `webhook.test` to be acknowledged as ignored, not to update a customer. Inspect provider delivery status and our fixed logs. Replay a delivery through the provider: when the same event/raw payload is resent with a fresh valid signature it must be `duplicate`.
5. Trigger a benign sandbox update for the already linked fictitious customer, or wait for an actual `customer.updated`. Check a `processed` receipt, a newer local `refreshed_at`, unchanged binding ID, correct requirement snapshot, and local operations still disabled. A test event alone does **not** prove customer synchronization. Temporarily enable the manual fixture flag only if needed for authenticated GET acceptance, then disable it again.
6. Keep the receiver enabled while its provider endpoint is active. To stop the test, disable the provider endpoint first, then disable the receiver; a disabled receiver returns 503 and will cause retries. The provider may not replay events emitted while its endpoint was disabled. Reconcile with explicit refresh after a gap.

## Validation and remaining limits

Automated tests cover exact-byte signatures, full-secret use, old/future timestamps, event-ID matching, missing environment, live exclusion, body limits, bearer separation, end-to-end receipt/snapshot updates, repeated deliveries, transaction rollback after snapshot writes, provider failures, foreign IDs, out-of-order notifications and browser-role restrictions. Embedded PostgreSQL tests serialize their single connection; real multi-connection locking and external delivery still require staging acceptance. No provider endpoint has been registered by this change.

Receipt hashes/outcomes are retained without an automatic cleanup job to preserve deduplication. Define retention against the provider replay window before adding cleanup. No webhook secret rotation orchestration, live-customer KYC integration or production-readiness claim is included in this milestone.

## Extensão para o cadastro do formulário

A migration 017 e customer-onboarding-submission.md estendem o receiver para vínculos sintéticos criados a partir do rascunho/termos. O ID resolve uma única tabela de origem; ambiguidades são recusadas. A migration precisa estar aplicada antes de publicar a extensão, mesmo com a flag de submissão desligada, porque o receiver ativo consulta a nova tabela. Assinatura, dedupe, atualizações atômicas e limites de produção deste documento continuam válidos.
