# Stored customer withdrawal result

`GET /v1/me/withdrawal-requests/:id/result` requires authenticated, unsuspended PF ownership. Unknown and foreign IDs both return `404 WITHDRAWAL_REQUEST_NOT_FOUND`. Responses use `Cache-Control: no-store`.

The server registers the database-only result service whenever a pool is configured. It is independent of withdrawal creation, operator approval and execution feature flags. No new flag or migration is required; migrations through 027 must already exist. This endpoint never calls OZAV, publishes a job, changes state, releases the pilot slot or requests a send.

The response distinguishes recorded/approved/uncertain and `provider_<status>` evidence. `provider_completed` requires the transfer and both legs to be completed. All evidence is a saved snapshot, with observation time and freshness explicitly not evaluated.

Amounts use six decimal places. `gross_amount` is the recorded converted amount; `net_amount` and `deducted_amount` are populated only for a completed observation with a valid positive target no larger than gross. The deduction is the difference of recorded source and target, not a verified fee breakdown. If the provider omits the target, both fields remain null. `fee_breakdown` stays null. No fee rate is assumed and no preliminary delivery promise is made.

Only the frozen destination, safe operation status and amounts are exposed. Operator identities/reasons, provider IDs, idempotency keys, Travel Rule data and provider transaction references are not returned. Sandbox provider completion does not establish on-chain delivery; `mainnet_execution`, `real_money` and `onchain_delivery_verified` remain false.

Staging acceptance: deploy with every write flag false, sign in as the owning customer and GET the known withdrawal result. Expect `provider_completed`, gross `198.050000`, unknown net/deduction, and `no-store`. Read it using another customer and expect 404. Existing POST creation and operator execution must remain disabled.
