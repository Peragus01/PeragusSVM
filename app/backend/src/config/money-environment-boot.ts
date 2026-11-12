import { resolveMoneyEnvironment, type MoneyEnvironment, type MoneyMode } from "./money-environment.js";

export interface MoneyEnvironmentProbes {
  ozavEnvironment(): Promise<string>;
  solanaGenesisHash(): Promise<string>;
}

type MismatchField = "ozav" | "solana_rpc" | "deployment" | "database";

const mismatch = (field: MismatchField): Error =>
  Object.assign(new Error("MONEY_ENVIRONMENT_MISMATCH"), {
    code: "MONEY_ENVIRONMENT_MISMATCH",
    field,
  });

async function probe(
  field: MismatchField,
  run: () => Promise<string>,
  expected: string,
): Promise<void> {
  let actual: string;
  try {
    actual = await run();
  } catch {
    // Fail closed: an unverifiable environment is treated as a mismatch.
    throw mismatch(field);
  }
  if (actual !== expected) throw mismatch(field);
}

/**
 * Refuses to start when the OZAV environment or Solana cluster reachable from
 * this process does not match the money environment derived from the deployment.
 * Never includes keys, URLs or probe values in the error.
 */
export async function assertMoneyEnvironmentAtBoot(
  money: MoneyEnvironment,
  probes: MoneyEnvironmentProbes,
): Promise<void> {
  await probe("ozav", probes.ozavEnvironment, money.mode);
  await probe("solana_rpc", probes.solanaGenesisHash, money.genesisHash);
}

/**
 * Refuses to start when the database is recorded for another money environment
 * (peragus_database_environment, migration 043). Missing or unreadable fails closed.
 */
export async function assertDatabaseEnvironment(
  pool: { query(sql: string): Promise<{ rows: unknown[] }> },
  mode: MoneyMode,
): Promise<void> {
  await probe("database", async () => {
    const r = await pool.query("select environment from peragus_database_environment");
    if (r.rows.length !== 1) throw new Error("DATABASE_ENVIRONMENT_UNRECORDED");
    return String((r.rows[0] as { environment: unknown }).environment);
  }, mode);
}

export interface MoneyEnvironmentBootDeps {
  ozavClient(apiKey: string, mode: MoneyMode): { getCapabilities(): Promise<{ environment: string }> };
  solanaConnection(rpcUrl: string): { getGenesisHash(): Promise<string> };
}

export interface MoneyEnvironmentBootEnv {
  PERAGUS_DEPLOYMENT_ENV: "staging" | "production";
  SOLANA_USDT_MINT?: string | undefined;
  SOLANA_RPC_URL?: string | undefined;
  OZAV_API_KEY?: string | undefined;
}

/**
 * Shared by the API and the worker. Skips only when the process is not
 * deployed (no RAILWAY_ENVIRONMENT_NAME and not production). The Solana
 * genesis probe always runs when deployed; the OZAV probe only with a key.
 */
export async function runMoneyEnvironmentBootChecks(
  env: MoneyEnvironmentBootEnv,
  deps: MoneyEnvironmentBootDeps,
  log: (entry: Record<string, unknown>) => void,
  runtime: { RAILWAY_ENVIRONMENT_NAME?: string | undefined } = process.env,
): Promise<void> {
  const railway = runtime.RAILWAY_ENVIRONMENT_NAME;
  const deployed = env.PERAGUS_DEPLOYMENT_ENV === "production" || Boolean(railway);
  if (!deployed) {
    log({ event: "money_environment_boot_checks_skipped" });
    return;
  }
  if (
    (railway === "production" && env.PERAGUS_DEPLOYMENT_ENV !== "production")
    || (env.PERAGUS_DEPLOYMENT_ENV === "production" && railway !== undefined && railway !== "production")
  ) {
    throw mismatch("deployment");
  }
  const money = resolveMoneyEnvironment(env);
  const probes: MoneyEnvironmentProbes = {
    ozavEnvironment: env.OZAV_API_KEY
      ? async () => (await deps.ozavClient(env.OZAV_API_KEY!, money.mode).getCapabilities()).environment
      : async () => money.mode,
    solanaGenesisHash: () => deps.solanaConnection(env.SOLANA_RPC_URL ?? "").getGenesisHash(),
  };
  await assertMoneyEnvironmentAtBoot(money, probes);
  log({
    event: "money_environment_verified",
    money_mode: money.mode,
    network: money.network,
    ozav_probed: Boolean(env.OZAV_API_KEY),
  });
}
