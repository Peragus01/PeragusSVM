# Authenticated customer reads

The existing demo proxy only supported health/settlement routes and did not forward customer bearer tokens. The new bridge adds exact GET-only resources:

- `/api/v1/me`
- `/api/v1/me/operations?limit=20&cursor=...`
- `/api/v1/me/withdrawal-requests/:uuid/result`

The server uses `PERAGUS_BACKEND_URL`, e.g. the staging Railway origin. Keep that variable server-side. These customer routes forward only Accept and Authorization, never cookies, and never follow redirects. HTTPS is required except for loopback local development. Requests and responses are no-store, with Vary Authorization. POST is rejected before provider I/O. Admin routes and other customer writes are not added to the proxy allowlist. Backend ownership checks remain authoritative.

Browser code imports the typed read client:

```ts
import {
  getCustomerOperations,
  getCustomerWithdrawalResult,
} from "@/lib/peragus/customer-reads";

// Obtain accessToken from the existing customer login/session layer.
const page = await getCustomerOperations(accessToken, { limit: 20, signal });
const nextPage = page.meta.next_cursor
  ? await getCustomerOperations(accessToken, { cursor: page.meta.next_cursor, signal })
  : null;
const withdrawalId = page.data[0]?.withdrawal?.id;
const result = withdrawalId
  ? await getCustomerWithdrawalResult(accessToken, withdrawalId, signal)
  : null;
```

The client always calls the same-origin `/api` bridge and has no configurable external destination. Tokens are supplied per call; it does not persist, log, refresh or retry sessions. Errors retain machine code/status with a neutral message. Dispose requests with AbortSignal on navigation/sign-out. Scope any React Query keys/cache to the authenticated customer and clear private cache on sign-out; never reuse another customer's pages. A 401 requests reauthentication; 403 denies access, 404 means unavailable/not owned, and AUTH_UNAVAILABLE/5xx is a temporary error, never an empty-history success.

Display the indicative estimate separately from `converted_target`. Do not format null net/deducted amounts as zero. `provider_completed` in this contract is sandbox provider completion, not onchain delivery. A `sim_custody_...` reference is not an explorer link. The API result explicitly reports unknown fees and false mainnet/onchain markers.

This change supplies the HTTP integration layer only. The current develop UI is the older settlement demo and has no customer login/session or customer Operations screen. No screen, login flow, sidebar, design or wallet signing behavior is changed. The separate customer UI should call these helpers after integrating its login layer. No backend migrations or financial flags change.

Acceptance after the frontend deploy: unauthenticated GET `/api/v1/me/operations` returns 401; an owner bearer returns the same three stored operations as the backend; a different customer returns only their own history; POST to these private read resources returns 405. Keep financial writes disabled.
