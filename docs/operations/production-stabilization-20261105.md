# Production stabilization — 2026-11-05

## Verified starting state

- main: `2a0413e353afe3f16054473bdc82d6374aa523ab`; develop: `90e537fbd2774435d52b24dd717c2dad48b1bfe4`.
- Vercel production had Next.js/Supabase integration variables, but no production `VITE_SUPABASE_URL` or `VITE_SUPABASE_PUBLISHABLE_KEY`. The Vite authentication bridge requires those names. Production-scoped public configuration was added using the production project's publishable key; secrets were not exposed.
- The rebuild `dpl_6aPVcRdbFFzk8bThuU5tpJD37Xcn` reached READY and www.peragus.com.br/login rendered an enabled login button without the unavailable warning. This is not evidence of successful account login.
- Railway production onboarding worker was CRASHED and pinned to `5462d22c1338d986366a555bb3dc06cf74ed0703`, independently of main. Its errors did not contain diagnostic categories.
- Production Supabase `athwkklyvnaetotmancy`: 9 recorded migrations, 8 public tables, 18 legacy settlement rows, zero Auth users. Staging is `lybdkqkbwlfwvmmvstzi`.

## Database changes and recovery

Before migrating production, a restricted in-database recovery copy was created in schema `peragus_release_backup_20261105`. It contains the eight previous public tables and migration ledger, is unavailable to public/anon/authenticated/service_role, and has RLS enabled. The settlement row count and ordered content digest matched (18 rows). This copy protects against release mistakes, not loss of the whole Supabase project; it does not replace an offsite backup/PITR policy.

Migrations 010–041 were applied transactionally with their exact repository SHA-256 checksums in `peragus_schema_migrations`, leaving 001–009 unchanged. Forty public tables and 42 migration records resulted. An equality check confirmed that all original settlement columns and rows were unchanged. A synthetic customer insert/read was rolled back; no probe customer remains.

Migration 042 revokes browser-role execution of the RLS event trigger and application trigger functions, and fixes search_path only for Peragus trigger functions. Existing pg-boss functions were not changed. Production advisor afterwards: INFO RLS-without-policies (intentional backend-only tables and recovery copies); six pg-boss search-path warnings; no remaining public SECURITY DEFINER execution warning.

Rollback policy: stop application writes, disable mail processing, and roll back the application release first. These are additive application tables; do not drop them or copy staging data. Restore old settlement data from the restricted copy only after reviewing affected rows and dependencies. Do not automate a destructive restoration while workers are running. A provider-wide disaster requires an external backup, which was not verified through the available connector.

## Worker boundaries

`ONBOARDING_EMAIL_DEPLOYMENT_ENV` explicitly selects staging or production and pins both Supabase Auth URL and database host/username to that project. A conflicting Railway environment name is rejected. Financial/demo/simulation flags and live OZAV keys remain rejected. The provider data model remains synthetic/test-only in both locations; this release does not implement live KYC.

The existing max-five confirmed-Auth-user allowlist remains mandatory when sending is enabled. Recipients are looked up in that environment's Auth database. Production mail remains disabled until a controlled production user, credentials and complete journey are validated. Disabled workers report an explicit standby event without contacting the database/provider. An enabled worker validates required schema before reporting ready.

Errors use a correlation UUID, stage, environment, retry category and allowlisted technical codes. Arbitrary exception messages/details are never logged. Transient cycle failures are logged and retried on the next cycle, while bootstrap failures fail closed. The outbox payload hash, Resend key and 23-hour retry cutoff are preserved. Resend documents a 24-hour idempotency window: https://resend.com/docs/dashboard/emails/idempotency-keys . Accepted does not mean delivered.

## Application and dependency validation

React effects now capture the intended lifecycle counter and focus-return element, and depend on stable customer IDs. Authentication helpers/context and the session provider are separate modules; the wallet observation hook is separate from the component. No lint rules were globally disabled.

Vite was updated to 8.3.6 and compatible lockfile updates resolved the reported high-severity Vite/Zod findings. Remaining moderate findings involve Solana web3 transitive uuid/stream-json and frontend TypeScript-ESLint/minimatch tooling. A forced web3 major upgrade would change blockchain integration and was deliberately excluded. The advisory descriptions alone do not prove production exploitability; payment flags must remain off.

## Remaining external verification

The Railway OAuth connector exposes variable names, not values. Therefore existing DATABASE_URL targets, shared encryption material and financial flag values cannot be inferred from names or successful deployments. They require verified configuration or runtime guards before enabling production processing. Production has no Auth user available for login/logout/MFA or onboarding email E2E. Do not manufacture operator JWTs, bypass MFA, or use a staging user as production evidence.

The GitHub connection has no ruleset/branch-protection mutation capability. A main ruleset still requires repository administration access: PR required, Frontend + Backend checks, deletion/force-push blocked, administrator emergency bypass with audit.

## Additional isolation found during validation

The API, invite worker, environment parser and invitation template also pinned staging. `PERAGUS_DEPLOYMENT_ENV` now selects the known database/Auth pair for controlled synthetic onboarding in either location. Production API startup fails closed on a cross-environment connection; this must be validated before switching its release. Invitation messages freeze the origin selected at issuance (production uses www.peragus.com.br), without rewriting existing queued bodies. No new live-provider operations are introduced.

`getEnv` reports only rejected field names through a typed sanitized configuration error. The disabled onboarding worker audits configuration without making provider/database calls and stays in explicit non-sending standby. Its diagnostic is distinct from operational processing readiness. This enables verification of connection configuration without reading secret values through the connector.
