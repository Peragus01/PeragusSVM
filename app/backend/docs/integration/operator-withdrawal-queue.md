# Operator withdrawal queue (stored sandbox records)

`GET /v1/admin/withdrawal-requests` discovers recorded withdrawals without manually copying IDs from a customer's response. It requires a dedicated operator account with confirmed email, no customer profile, inclusion in `WITHDRAWAL_OPERATOR_USER_IDS`, and backend-verified `aal2`. Customer profile overlap is blocked even when mistakenly allowlisted. An empty allowlist denies access.

This database-only service is registered independently of approval/send flags. Keep every financial write flag false while reading. No migration, new flag, provider call, state change, signing, job publication or pilot-slot release is introduced. Existing migrations through 027 are required. This route is not added to the frontend customer proxy.

Query parameters:

| Field | Values |
|---|---|
| `state` | `pending_approval` (default), `approved`, `reserved`, `uncertain`, `processing`, `completed`, `needs_review`, `all` |
| `limit` | 1–50, default 20 |
| `cursor` | Opaque positioning token from `meta.next_cursor` |

Only these parameters are accepted. Results are newest first, ordered by recorded request `(created_at,id)`, preserving timestamp microseconds. Return `meta.has_more` and `meta.next_cursor`. Keep the same filter when following pages. Filtering describes the current stored state, so records may move between filters; refresh from the first page to obtain new states. A cursor is not authorization.

States: no approval is pending; an existing approval without execution is approved; an execution claim without an attempted POST is reserved; an attempted POST without saved observation is uncertain. Completed requires transfer status and both legs completed. Provider terminal failures/review states, and a completed transfer with incomplete leg evidence, require review. Other observations are processing. These are stored evidence, not a live eligibility or provider-freshness check.

Projection includes local withdrawal, customer, purchase and Pix IDs, frozen gross USDT amount/destination, approval time and safe lifecycle markers. Operator IDs/reasons, request/idempotency keys, provider IDs/references, Travel Rule and onboarding payloads are excluded. `execution_authorized` and `onchain_delivery_verified` remain false. Listing a record does not approve or execute it; write routes retain their own flags and eligibility checks.

Responses use `Cache-Control: no-store`. Missing auth returns 401, absent operator role/MFA or customer overlap 403, invalid query 400, and unavailable database/service 503 without exposing database details.

Staging acceptance: with all writes off, log in as the dedicated operator, verify MFA and list `state=all`; the known withdrawal should be completed in sandbox. The pending-only view excludes it. Without MFA expect 403, with a customer account expect 403, and with caller `customer_id` selector expect 400. Confirm existing approval and execution POST routes remain disabled.
