# Stored operator withdrawal audit

`GET /v1/admin/withdrawal-requests/:id/audit` returns the recorded purchase, Pix conversion, immutable operator approval and sandbox execution for one withdrawal. It uses the same dedicated-account separation, UUID allowlist and backend-verified MFA (`aal2`) as the operator queue. It is not exposed through the customer frontend proxy.

The service runs one SELECT and remains available with all financial write flags disabled. It does not refresh OZAV evidence, re-evaluate current KYC/eligibility, reconcile, approve, execute, publish jobs or release the pilot slot. No migration or new configuration is required; existing migrations through 027 are prerequisites.

The response includes local correlation IDs, frozen destination/proof verification time, indicative purchase estimate, saved Pix states and converted amount, and approval actor UUID/reason/time. Approval detail is operator-only. Execution details include saved state, both legs, unknown-or-reported target amount and whether the pilot slot is held. No raw onboarding/Travel Rule data, provider IDs/references, request/idempotency keys, tokens or proof signatures are selected.

`recorded_at` is local record creation; `last_updated_at` is local row update time, not proof of the exact provider completion or broadcast time. `observation_freshness` is not evaluated. A transfer and both legs must be completed for `provider_completed` or `conversion_completed` to be true. Missing target remains null; fee breakdown remains unknown. Sandbox completion is not onchain delivery.

`integrity` compares the linked local records' frozen customer/destination/funding/amount bindings. The converted amount comparison uses six-decimal integer arithmetic. Missing approval/execution produces null for its corresponding check. These flags describe stored record consistency only, not live authorization. The audit remains readable if the target customer is later suspended or a stored binding differs; it reports the mismatch without permitting execution. Unknown withdrawal IDs return 404.

Require no query parameters or request body. Invalid UUID/selectors return 400; missing auth 401; unauthorized/no-MFA/customer overlap 403; unavailable database 503 without raw error detail. Successful and handler-error responses use no-store.

Staging acceptance: dedicated MFA operator reads the known withdrawal, checks frozen BRL 1000 and gross USDT 198.050000, matching local references, immutable approval and completed sandbox execution with unknown target. Keep sends disabled. Test customer account 403, no-MFA operator 403, unknown UUID 404 and selector rejection 400. No extra withdrawal is required.
