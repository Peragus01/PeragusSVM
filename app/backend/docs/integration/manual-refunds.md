# Manual refund requests — sandbox records

This flow tracks a customer's request and the operator's manual decision. It never calls OZAV, signs, queues, cancels a transfer or initiates a refund. All records are test-environment evidence. The operator must review where funds are and arrange any actual return separately before recording completion. No refund entitlement, SLA or automatic approval is implied.

Apply migration **028_add_manual_refund_requests.sql before deploying**, since operation history and operator withdrawal queue/audit now join the new tables. `MANUAL_REFUNDS_ENABLED=false` by default gates all case creation, decisions and completion records. GET reads remain available while writes are disabled. Enable only on API staging for controlled acceptance; no worker change. Pinning, existing financial-write guards and an explicit operator allowlist apply. An OZAV key is not needed for this module.

## Customer

`GET|POST /v1/me/operations/:purchaseId/refund-request` requires the authenticated unsuspended PF owner. A rejected KYC result does not itself prevent a request. Creation requires stored, matching BRL/Pix funding evidence with a completed source leg; the conversion may have failed or the withdrawal may already have started. Missing/foreign operation returns 404, unconfirmed funding 409.

POST body: `{request_id, reason}`. Reason is trimmed, 10–500 characters, no control characters. Amount, currency, beneficiary and provider selectors are not accepted. Requested BRL is derived from the paid Pix, never the indicative USDT estimate. A single immutable request is allowed per purchase/Pix. Same key/body replays; changed body conflicts; another key for the same operation returns REFUND_ALREADY_REQUESTED.

Customer state is `pending_review`, `approved`, `rejected` or `refund_recorded`. Approval means only a decision has been recorded. Completion is explicitly a manual operator assertion, with `provider_verified:false`, not an independently verified bank refund. Customer sees their own request reason, requested amount, decision time and manually recorded returned amount/time. Internal operator reason/UUID/reference are excluded.

## Operator

Dedicated non-customer account, UUID allowlist and backend-verified MFA aal2 are required on every admin route:

- `GET /v1/admin/refund-requests?state=pending_review&limit=20&cursor=...` (states also approved/rejected/refund_recorded/all, limit 1–50).
- `GET /v1/admin/refund-requests/:id` includes request, decision audit and saved withdrawal context.
- `POST /v1/admin/refund-requests/:id/decision`: `{request_id, decision:"approved"|"rejected", reason, confirmation:"MANUAL_REVIEW_COMPLETED"}`. Reason 10–300 chars. One immutable decision per case.
- `POST /v1/admin/refund-requests/:id/completion`: `{request_id, amount_brl, reference, confirmation:"MANUAL_REFUND_EXECUTED_EXTERNALLY"}`. Only after approval. Reference is 8–160 chars with no controls; use an opaque protocol/reference, not private bank data or credentials. This is a reference field, not a file-upload endpoint.

The amount actually returned must be positive BRL with at most two decimals and no greater than the paid Pix. Partial returns are explicitly marked `partial_refund:true`; this version records one final manual outcome per case, not multiple installments. `refund_recorded` does not mean a full refund when partial_refund is true. Decision/completion keys are scoped per operator and action, replay identically and conflict on changes. Database uniqueness handles concurrent attempts. Completion cannot reference a rejected decision, and DB constraints cap the amount at the paid Pix. All three tables are append-only, RLS enabled and browser roles revoked.

## Transfer coordination

The customer operation history and operator withdrawal queue/audit expose the refund case ID/state. Requesting or approving a refund **does not automatically cancel, stop, restart, reverse or release** the existing withdrawal. During this MVP all financial execution remains manually gated; inspect withdrawal context and coordinate any refund/withdrawal activity before acting. A started, uncertain or completed send requires explicit manual funds review. Read-only reconciliation remains a separate tool to determine the saved send outcome. Neither an approval nor a completion here is an authorization to execute another transfer.

All responses use no-store. Avoid logging tokens, raw database errors or private bank records. Each request/decision/completion is only evidence in Peragus; repeated calls cannot themselves produce a duplicate bank refund because there is no financial provider call at all.

## Acceptance

With existing financial flags false and only MANUAL_REFUNDS_ENABLED temporarily true, create a synthetic sandbox request using the known paid operation, test replay/owner isolation, read it as the MFA operator, record a decision, and verify approved is distinct from completion. Test a rejection on a separate case. If exercising completion in sandbox use a clearly synthetic reference and amount, not a claimed real return. Verify customer views hide operator/reference data and update/delete is blocked. Disable MANUAL_REFUNDS_ENABLED after acceptance. Frontend request/management screens are separate work; the customer proxy is not expanded to expose admin or financial writes by this change.
