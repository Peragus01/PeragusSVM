# Dedicated customer document page

The authenticated customer page `/app/documentos` contains the requested document categories, synthetic-file upload and receipt history. The existing onboarding flow now presents a read-only summary and a link to this page instead of mounting the upload form inside account details. Desktop navigation includes Documents; the existing five mobile shortcuts remain, with the page accessible through My account or the navigation menu.

Receipt labels distinguish a necessary document, pending receipt, a received file awaiting identity analysis, and a rejected file. A received front image never establishes complete identity verification. Existing uncertain records remain visible and block their category/side until resolved. The synthetic-file confirmation remains mandatory in staging; it is not legal consent or production KYC.

Backend PR #79 adds the existing `request_id` to authenticated own-customer document metadata. A lost upload response is reconciled only when list/refresh confirms a terminal result for that exact request. A receipt belonging to another request cannot clear the warning. No declaration/upload is retried automatically. Legacy replies without correlation remain readable and fail closed for ambiguous recovery. The frontend retains no file, draft, token or receipt in browser storage.

The page uses existing protected document endpoints and introduces no database migration, provider operation, environment variable or financial activation. Staging ledger migrations 037 through 041 were inspected, including both existing 037 filenames; none were renamed or reapplied. Invitation email and signup were already validated, and field-validation PR #78 remains on the integration branch. Legal-registration PR #73 is still separate and is not merged by this delivery.

Validation covers required/pending/received/rejected states, synthetic confirmation, single upload on double click, exact-request recovery, unrelated receipt refusal, definitive validation rejection, old uncertain record refresh, private state reset and late response isolation, authenticated route ancestry and the read-only account summary. Existing document proxy/authentication and backend ownership/idempotency tests remain in place.

The live authenticated page still requires the customer's session for visual acceptance. This UI delivery does not claim a new end-to-end identity verification or resolution of historical provider records without saved provider IDs.
