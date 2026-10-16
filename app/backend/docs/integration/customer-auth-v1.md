# Customer authentication: first backend milestone

## Scope and compatibility

Email/password identity is supplied by Supabase Auth. The frontend owns signup,
email confirmation, login, password recovery, refresh and logout. The API never
accepts passwords, refresh tokens, client-supplied user IDs or verification status.

This milestone implements verified identity, a minimal PF/PJ profile, and owned
settlement reads. It does NOT implement KYC/KYB submission, review/approval,
wallet ownership verification, invitations, business members, API keys or payment
routing. No profile can operate in this milestone, including an approved profile.
One Auth user has one customer profile, either PF or PJ. Simultaneous personal
and business accounts and multi-company switching require a later membership model.

All executable API /v1 endpoints now require authentication. Existing unauthenticated
curl and demo flows will return 401 after deployment. /health stays public.
The lower-level buildApp factory permits isolated legacy test fixtures; the server
entry point always supplies access control and has no environment bypass flag.

Do not merge/deploy before staging configuration and migration are ready. Production
is out of scope. No migrations have been applied to hosted databases by this PR.

## Staging preparation

API service PeragusSVM, staging only:

- SUPABASE_URL=https://lybdkqkbwlfwvmmvstzi.supabase.co
- SUPABASE_PUBLISHABLE_KEY=<project publishable key, configured privately>
- DATABASE_URL remains the existing staging database connection.
- Keep OZAV_ONRAMP_WRITES_ENABLED, OZAV_OFFRAMP_WRITES_ENABLED,
  SOLANA_COSIGNING_ENABLED, SOLANA_CONTINGENCY_RESERVE_ENABLED and
  PERAGUS_SANDBOX_DEMO_ENABLED false on API and worker.
- WORKER_SMOKE_TEST_ENABLED remains false.

The Auth configuration is required only on the API, not the worker. Use the staging
project's publishable key (legacy anon key also works), never a service_role or
secret key. Do not put a database connection string or private provider key in
VITE_* variables. Configure email/password and email confirmation on staging.
Frontend redirect URLs must be provided by the frontend developer; do not guess a
production URL. The API does not use redirect URLs.

Before deploying, apply only migration 010 through the normal migration runner,
which skips existing matching migrations. First confirm the database is the known
staging project. From app/backend, after npm ci and npm run build, use an explicit
.env.staging file and the destination guard:

```bash
env -u DATABASE_URL -u DATABASE_SSL DOTENV_CONFIG_PATH=.env.staging \
  node --import dotenv/config --input-type=module <<'NODE'
import { assertSmokeTestSafety } from './dist/jobs/worker-smoke-test.js';
const names = ['OZAV_ONRAMP_WRITES_ENABLED', 'OZAV_OFFRAMP_WRITES_ENABLED',
  'SOLANA_COSIGNING_ENABLED', 'SOLANA_CONTINGENCY_RESERVE_ENABLED',
  'PERAGUS_SANDBOX_DEMO_ENABLED'];
const flags = {};
for (const name of names) {
  if (process.env[name] !== 'false') throw new Error(`${name} must be explicitly false`);
  flags[name] = false;
}
assertSmokeTestSafety({ DATABASE_URL: process.env.DATABASE_URL, ...flags });
if (process.env.DATABASE_SSL !== 'true') throw new Error('Staging requires SSL');
await import('./scripts/migrate.mjs');
NODE
```

Do not print .env.staging or commit it. No financial provider call is made by the
migration. No legacy settlement is assigned to a customer. RLS is enabled with no
browser access policies and explicit revocation of anon/authenticated table grants.
The database runtime role must have access to the table (current staging uses
postgres). Clients never query this table through Supabase Data API.

## Frontend contract

Send `Authorization: Bearer <session.access_token>` on every /v1 call. If using
/api proxy, explicitly forward that header; the current proxy drops it. It must
also preserve relevant response headers such as Retry-After. Never forward client
user IDs or accept wallet connection as account authentication. A separate API
origin requires an explicit allowed-origin CORS design; current integration uses
the same-origin frontend proxy.

The backend calls the configured Supabase project's getUser(token) on each request.
This verifies the token with Auth and obtains current user information instead of
trusting decoded browser claims. There is a five-second Auth request deadline,
no persisted server session, no auto-refresh, and redirects are rejected. This adds
one Auth network request per API request; polling frequency should be conservative.
Do not assume logout instantly invalidates every previously issued access token.
Passwords and refresh tokens go only to Supabase Auth, not Peragus endpoints.

### GET /v1/me

200: `{ "data": { "user": { "id": "<auth UUID>", "email": "..." }, "customer": null } }`
If present, customer has the same shape as below. The frontend can use this to
choose profile onboarding versus the account area.

### POST /v1/me/customer

Exactly two fields, with lowercase type values:

```json
{ "type": "pf", "display_name": "Customer name" }
```

PJ tab uses `"type": "pj"` and the business display name. This is only a minimal
profile, not a completed legal registration. Display name is 2–160 characters after
trimming. Do not collect/upload CPF/CNPJ, document images or KYB beneficial-owner
records through this endpoint; their requirements and secure storage are pending.

201 for first creation, 200 for an identical normalized replay:

```json
{
  "data": {
    "id": "<customer UUID>",
    "type": "pf",
    "display_name": "Customer name",
    "verification_status": "draft",
    "suspended": false,
    "operations_enabled": false
  }
}
```

The owner comes from the verified token. Existing profile with a different type or
name returns 409 CUSTOMER_ALREADY_EXISTS. There is no type-change or profile-edit
endpoint yet. Frontend should resume an existing profile rather than recreate it.

### GET /v1/me/customer

200 with `{ "data": null }` or the customer object above. No other user's customer
can be selected by query string, header or body. /v1/me is sufficient for most UIs.

### Settlement routes

All GET/HEAD settlement subresources (including audit and onramp) require ownership
of settlements.customer_id. Another customer's ID, missing ID, and legacy unowned
ID return the same 404 SETTLEMENT_NOT_FOUND. A malformed UUID returns 400.
Suspended customers receive 403 on settlement routes but may read their own profile.

All POST settlement routes are closed before invoking their handlers. Draft/unapproved
profiles return 403 CUSTOMER_NOT_APPROVED; approved profiles return 503
OPERATIONS_NOT_ENABLED. Existing global provider customer IDs are not safe for
multi-customer financial use; per-customer routing must be implemented first.
No customer approval endpoint exists. A browser cannot self-approve a profile.

### Errors

| HTTP | Code | Frontend action |
| --- | --- | --- |
| 401 | AUTH_REQUIRED / INVALID_TOKEN | Obtain a valid session; do not retry forever |
| 403 | EMAIL_NOT_CONFIRMED | Complete email confirmation |
| 503 | AUTH_UNAVAILABLE | Preserve session; offer bounded retry |
| 400 | VALIDATION_ERROR | Correct the profile payload |
| 409 | CUSTOMER_ALREADY_EXISTS | Load the existing profile |
| 403 | CUSTOMER_REQUIRED | Complete minimal profile onboarding |
| 403 | CUSTOMER_SUSPENDED | Show access restriction |
| 403 | CUSTOMER_NOT_APPROVED | Show verification pending |
| 503 | OPERATIONS_NOT_ENABLED | Do not display an enabled payment action |
| 404 | SETTLEMENT_NOT_FOUND | Show unavailable settlement without disclosing ownership |

API responses are no-store on protected routes. The frontend's current generic
error mapper must add these codes. Do not display raw provider/internal errors.
Authorization and cookie headers are redacted by the executable API logger.

## Acceptance and remaining work

Unit/injection tests cover auth denials, identity and profile spoofing, PF/PJ replay,
foreign and legacy settlements across every existing subroute, suspension, and
closed financial handlers. Embedded PostgreSQL tests apply migrations 001–010,
preserve a pre-010 settlement, exercise owner uniqueness/ownership and RLS/grants.
These are local tests, not proof of hosted Auth or staging migration execution.

Staging validation after deployment needs two confirmed Auth users, PF and PJ
profiles, unauthenticated 401 and forbidden-operation checks. Do not manually
assign old financial/demo settlements to those users just to make tests pass.

Next milestone: approved KYC/KYB lifecycle from the provider, owned settlement
creation with customer-scoped request_id uniqueness, provider/customer and wallet
bindings, authorization in asynchronous execution, and outbox recovery. Existing
request_id uniqueness remains global because creation is closed in this milestone.
An owned read requires a legitimately owned record from that later milestone.

Rollback is staging-only and must keep financial flags disabled. Do not roll back
to an unauthenticated API while exposing customer data; disable access/stop staging
API instead if needed. Migration is additive: leave the table and nullable column
in place rather than delete customer records. Keep token values out of PRs/logs.
