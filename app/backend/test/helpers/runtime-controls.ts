/**
 * Runtime kill switches (migration 054) start OFF in every environment (fail closed).
 * Suites that perform a guarded action (quote, purchase accept, Pix create, send claim,
 * onboarding submission or verification start) turn the switches they need ON here,
 * explicitly, after recording the database environment. The real switch flow (admin
 * route, fresh MFA, audit) is covered by test/runtime-controls.test.ts.
 */
export const RUNTIME_CONTROL_KEYS = ["new_operations", "usdt_sends", "onboarding"] as const;
type Key = (typeof RUNTIME_CONTROL_KEYS)[number];
interface Queryable { query(sql: string, params?: unknown[]): Promise<unknown> }

export async function setRuntimeControls(db: Queryable, enabled: boolean, keys: readonly Key[] = RUNTIME_CONTROL_KEYS) {
  await db.query(
    `update peragus_runtime_controls set enabled=$1,updated_at=now()
     where key=any($2::text[]) and environment=(select environment from peragus_database_environment)`,
    [enabled, [...keys]],
  );
}
export const enableRuntimeControls = (db: Queryable, keys: readonly Key[] = RUNTIME_CONTROL_KEYS) => setRuntimeControls(db, true, keys);
export const pauseRuntimeControls = (db: Queryable, keys: readonly Key[] = RUNTIME_CONTROL_KEYS) => setRuntimeControls(db, false, keys);
