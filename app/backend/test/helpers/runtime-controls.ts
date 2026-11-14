/**
 * Runtime kill switches (migration 054) start OFF in every environment (fail closed).
 * Suites that perform a guarded action (quote, purchase accept, Pix create, send claim,
 * onboarding submission or verification start) turn the switches they need ON here,
 * explicitly, after recording the database environment. The real switch flow (admin
 * route, fresh MFA, audit) is covered by test/runtime-controls.test.ts.
 *
 * new_operations is also gated by the daily review (migration 055): enabling it here
 * records a synthetic review of the previous and the current São Paulo day, so a suite
 * that runs across midnight is never blocked by its own earlier activity. The real
 * review flow is covered by test/daily-review.test.ts.
 */
export const RUNTIME_CONTROL_KEYS = ["new_operations", "usdt_sends", "onboarding"] as const;
type Key = (typeof RUNTIME_CONTROL_KEYS)[number];
interface Queryable { query(sql: string, params?: unknown[]): Promise<unknown> }

export const SYNTHETIC_REVIEWER = "00000000-0000-4000-8000-00000000d41e";

export async function setRuntimeControls(db: Queryable, enabled: boolean, keys: readonly Key[] = RUNTIME_CONTROL_KEYS) {
  await db.query(
    `update peragus_runtime_controls set enabled=$1,updated_at=now()
     where key=any($2::text[]) and environment=(select environment from peragus_database_environment)`,
    [enabled, [...keys]],
  );
}

/** Records a daily review of the previous and the current São Paulo day (idempotent). */
export async function reviewRecentDays(db: Queryable) {
  await db.query(
    `insert into peragus_daily_reviews(day,environment,reviewed_by,note)
     select (now() at time zone 'America/Sao_Paulo')::date-v.d,e.environment,$1::uuid,'synthetic test review'
     from peragus_database_environment e cross join (values (0),(1)) v(d)
     on conflict (day,environment) do nothing`,
    [SYNTHETIC_REVIEWER],
  );
}

export async function enableRuntimeControls(db: Queryable, keys: readonly Key[] = RUNTIME_CONTROL_KEYS) {
  await setRuntimeControls(db, true, keys);
  if (keys.includes("new_operations")) await reviewRecentDays(db);
}
export const pauseRuntimeControls = (db: Queryable, keys: readonly Key[] = RUNTIME_CONTROL_KEYS) => setRuntimeControls(db, false, keys);
