# Customer operation history (sandbox)

`GET /v1/me/operations?limit=20&cursor=...` lists purchase-intent operations, most recent first. Quotes without a purchase intention are not operations in this endpoint. Authentication and an unsuspended PF customer profile are required. Empty history returns `200` with an empty `data` array. All successful and handler-error responses use `Cache-Control: no-store`.

`limit` is an integer from 1 through 50 (default 20). Only `limit` and `cursor` are accepted. `meta.has_more` and `meta.next_cursor` support pagination. Pass the cursor unchanged. Its base64url encoding contains the purchase timestamp at database microsecond precision and the local purchase UUID; it is a positioning hint, not authorization. Every page and every join is scoped to the authenticated customer. The stable descending `(created_at,id)` order prevents timestamp ties from duplicating or skipping existing rows. New rows ahead of a cursor appear when the client refreshes the first page. Statuses reflect current saved evidence, not a frozen cross-page snapshot.

Each item returns local purchase and quote IDs, BRL source amount, explicitly indicative USDT estimate, frozen Solana destination and optional Pix/withdrawal summaries. `converted_target` is populated only when the saved Pix transfer and both legs completed with a valid positive USDT amount. A completed conversion does not imply a completed withdrawal. A completed sandbox withdrawal does not imply onchain delivery.

For net and deducted amounts use the withdrawal's relative `result_path`, implemented by PR #25. The history does not invent or independently recalculate fees. Unknown delivery amounts remain unknown in the result endpoint.

Provider IDs, operator identities/reasons, proof signatures, request/idempotency keys, private onboarding data and raw provider payloads are excluded. Historical records remain readable even if KYC is subsequently rejected; read access does not grant eligibility for another operation. Suspended customers remain blocked by the shared authentication gate.

The service runs one bounded SELECT per page, with no provider calls, mutation, job publication or signer dependency. All financial write flags can remain false. No new flag or migration; existing migrations through 027 are required. Node API startup wires the history service when a database pool exists.

Staging acceptance: owner GET returns the known completed sandbox purchase with its withdrawal `result_path`; a different customer sees only their own operations. Reject caller customer selectors and malformed pagination with 400. Keep all writes disabled.
