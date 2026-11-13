// Real-PostgreSQL race tests (*.pg.test.ts) run against CI's postgres:17 service
// (TEST_INVITE_DATABASE_URL, set at the backend job level in .github/workflows/ci.yml).
// Locally (no Postgres on Windows, Ruling 24) they skip; in CI a missing URL fails
// loudly instead of skipping, so the race proofs can never silently stop running.
export function realPostgresUrl(): string | undefined {
  const url = process.env.TEST_INVITE_DATABASE_URL;
  if (!url && process.env.CI === "true") throw Error("TEST_INVITE_DATABASE_URL_REQUIRED_IN_CI");
  if (url && !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("DISPOSABLE_LOCAL_DATABASE_REQUIRED");
  return url;
}
