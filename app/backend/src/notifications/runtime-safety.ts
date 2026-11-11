import { moneyModeFor } from "../config/money-environment.js";
import { OzavClientError } from "../providers/ozav-client.js";
// Deployment location and provider mode are separate: both locations run only
// controlled synthetic onboarding until a separately reviewed live integration.
const projects = {
  staging: "lybdkqkbwlfwvmmvstzi",
  production: "athwkklyvnaetotmancy",
} as const;
export class NotificationConfigurationError extends Error {
  constructor(
    code: string,
    public readonly fields: string[],
  ) {
    super(code);
  }
}
export function assertDeploymentDatabase(
  env: {
    DATABASE_URL?: string | undefined;
    SUPABASE_URL?: string | undefined;
  },
  runtime: NodeJS.ProcessEnv,
  mode: string | undefined,
) {
  if (mode !== "staging" && mode !== "production")
    throw Error("ONBOARDING_ENV_REQUIRED");
  if (
    runtime.RAILWAY_ENVIRONMENT_NAME &&
    runtime.RAILWAY_ENVIRONMENT_NAME !== mode
  )
    throw Error("ONBOARDING_ENV_MISMATCH");
  const project = projects[mode];
  let db: URL;
  try {
    db = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw Error("ONBOARDING_DATABASE_INVALID");
  }
  let username: string;
  try {
    username = decodeURIComponent(db.username);
  } catch {
    throw Error("ONBOARDING_DATABASE_INVALID");
  }
  const direct =
    db.hostname === `db.${project}.supabase.co` && username === "postgres";
  const pooler =
    /^aws-[0-9]+-sa-east-1\.pooler\.supabase\.com$/.test(db.hostname) &&
    username === `postgres.${project}`;
  const failures: string[] = [];
  if (!direct && !pooler) {
    if (
      db.hostname !== `db.${project}.supabase.co` &&
      !/^aws-[0-9]+-sa-east-1\.pooler\.supabase\.com$/.test(db.hostname)
    )
      failures.push("DATABASE_HOST");
    if (!(
      (db.hostname === `db.${project}.supabase.co` &&
        username === "postgres") ||
      (/^aws-[0-9]+-sa-east-1\.pooler\.supabase\.com$/.test(db.hostname) &&
        username === `postgres.${project}`)
    ))
      failures.push("DATABASE_USER_PROJECT");
  }
  if (!["", "5432"].includes(db.port)) failures.push("DATABASE_SESSION_PORT");
  if (!["postgres:", "postgresql:"].includes(db.protocol))
    failures.push("DATABASE_PROTOCOL");
  if (db.pathname !== "/postgres") failures.push("DATABASE_NAME");
  // pg-connection-string accepts these query parameters as overrides. Do not
  // validate one URL authority and then let pg connect using another one.
  if (
    ["host", "user", "port", "database", "password"].some((k) =>
      db.searchParams.has(k),
    )
  )
    failures.push("DATABASE_URL_OVERRIDES");
  if (env.SUPABASE_URL !== `https://${project}.supabase.co`)
    failures.push("SUPABASE_URL");
  if (failures.length)
    throw new NotificationConfigurationError(
      "ONBOARDING_DATABASE_MISMATCH",
      failures,
    );
  return mode;
}

export function assertNotificationEnvironment(
  env: {
    DATABASE_URL?: string | undefined;
    SUPABASE_URL?: string | undefined;
    OZAV_API_KEY?: string | undefined;
    OZAV_ONRAMP_WRITES_ENABLED: boolean;
    OZAV_OFFRAMP_WRITES_ENABLED: boolean;
    SOLANA_COSIGNING_ENABLED: boolean;
    SOLANA_CONTINGENCY_RESERVE_ENABLED: boolean;
    PERAGUS_SANDBOX_DEMO_ENABLED: boolean;
    CUSTOMER_VERIFICATION_SIMULATION_ENABLED: boolean;
    CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED: boolean;
  },
  runtime: NodeJS.ProcessEnv,
) {
  const mode = assertDeploymentDatabase(
    env,
    runtime,
    runtime.ONBOARDING_EMAIL_DEPLOYMENT_ENV,
  );
  if (!/^ozav_sk_test_[A-Za-z0-9_-]+$/.test(env.OZAV_API_KEY ?? ""))
    throw Error("ONBOARDING_TEST_PROVIDER_REQUIRED");
  if (
    env.OZAV_ONRAMP_WRITES_ENABLED ||
    env.OZAV_OFFRAMP_WRITES_ENABLED ||
    env.SOLANA_COSIGNING_ENABLED ||
    env.SOLANA_CONTINGENCY_RESERVE_ENABLED ||
    env.PERAGUS_SANDBOX_DEMO_ENABLED ||
    env.CUSTOMER_VERIFICATION_SIMULATION_ENABLED ||
    env.CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED
  )
    throw Error("ONBOARDING_UNSAFE_FLAGS");
  return mode;
}

// Public project identifiers and comparisons only. Never log the connection
// string, password, API keys, owner IDs or arbitrary configuration values.
export function deploymentConfigurationAudit(
  runtime: NodeJS.ProcessEnv = process.env,
) {
  let db: URL | undefined;
  try {
    db = new URL(runtime.DATABASE_URL ?? "");
  } catch {
    /* invalid is reported below */
  }
  const host = db?.hostname ?? "";
  let username = "";
  try {
    username = decodeURIComponent(db?.username ?? "");
  } catch {
    /* invalid */
  }
  const refs = Object.values(projects);
  const project = refs.find(
    (p) => host === `db.${p}.supabase.co` || username === `postgres.${p}`,
  );
  const moneyMode = moneyModeFor({
    PERAGUS_DEPLOYMENT_ENV:
      runtime.PERAGUS_DEPLOYMENT_ENV === "production" ? "production" : "staging",
  });
  return {
    event: "deployment_configuration_audit",
    money_mode: moneyMode,
    network: moneyMode === "live" ? "solana:mainnet" : "solana:devnet",
    environment: ["staging", "production"].includes(
      runtime.RAILWAY_ENVIRONMENT_NAME ?? "",
    )
      ? runtime.RAILWAY_ENVIRONMENT_NAME
      : "local",
    deployment_id: /^[a-f0-9-]{36}$/.test(runtime.RAILWAY_DEPLOYMENT_ID ?? "")
      ? runtime.RAILWAY_DEPLOYMENT_ID
      : null,
    commit: /^[a-f0-9]{40}$/.test(runtime.RAILWAY_GIT_COMMIT_SHA ?? "")
      ? runtime.RAILWAY_GIT_COMMIT_SHA
      : null,
    database_project: project ?? "unrecognized",
    auth_project:
      refs.find((p) => runtime.SUPABASE_URL === `https://${p}.supabase.co`) ??
      "unrecognized",
    database_host_kind:
      host === `db.${project}.supabase.co`
        ? "direct"
        : /^aws-[0-9]+-sa-east-1\.pooler\.supabase\.com$/.test(host)
          ? "sa_east_pooler"
          : "unrecognized",
    database_session_port: ["", "5432"].includes(db?.port ?? "invalid"),
    database_ssl: runtime.DATABASE_SSL === "true",
    provider_test: /^ozav_sk_test_/.test(runtime.OZAV_API_KEY ?? ""),
    financial_flags_disabled: [
      "OZAV_ONRAMP_WRITES_ENABLED",
      "OZAV_OFFRAMP_WRITES_ENABLED",
      "SOLANA_COSIGNING_ENABLED",
      "SOLANA_CONTINGENCY_RESERVE_ENABLED",
      "PERAGUS_SANDBOX_DEMO_ENABLED",
    ].every((k) => runtime[k] !== "true"),
  };
}
export class NotificationStageError extends Error {
  constructor(
    public readonly stage: string,
    cause: unknown,
  ) {
    super("ONBOARDING_STEP_UNCONFIRMED", { cause });
  }
}
export async function notificationStep<T>(
  stage: string,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw new NotificationStageError(stage, error);
  }
}
export function notificationFailure(
  error: unknown,
  stage: string,
  environment: string,
  correlationId: string,
) {
  if (error instanceof NotificationStageError)
    return notificationFailure(
      error.cause,
      error.stage,
      environment,
      correlationId,
    );
  const provider = error instanceof OzavClientError;
  const providerCode = provider
    ? error.statusCode && error.statusCode >= 100 && error.statusCode <= 599
      ? `OZAV_HTTP_${error.statusCode}`
      : "OZAV_TRANSPORT_OR_RESPONSE"
    : undefined;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const fields =
    error &&
    typeof error === "object" &&
    "fields" in error &&
    Array.isArray(error.fields)
      ? error.fields
          .filter(
            (field: unknown) =>
              typeof field === "string" && /^[A-Z0-9_]+$/.test(field),
          )
          .slice(0, 20)
      : undefined;
  const domainCode =
    /^(VERIFICATION|SCREENING)_(CUSTOMER_REQUIRED|FULL_MODE_REQUIRED|CAPABILITY_REQUIRED|PROCESSING|RECOVERY_REQUIRED|NOT_STARTED|CONFLICT|OUTCOME_MISMATCH|RECONCILIATION_REQUIRED)$/.test(
      code,
    )
      ? code
      : undefined;
  const internal =
    error instanceof Error &&
    /^(ONBOARDING_[A-Z_]+|ENVIRONMENT_CONFIGURATION_INVALID)$/.test(
      error.message,
    )
      ? error.message
      : undefined;
  const databaseCode = /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  const databaseReason =
    databaseCode && error instanceof Error
      ? ["EMAXCONNSESSION", "EMAXCLIENTS", "ECHECKOUTFAILED"].find((value) =>
          error.message.includes(value),
        )
      : undefined;
  const transport = [
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "ECONNRESET",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ].includes(code)
    ? code
    : undefined;
  return {
    event: "onboarding_email_failure",
    error_type:
      error instanceof Error &&
      [
        "Error",
        "TypeError",
        "ReferenceError",
        "SyntaxError",
        "RangeError",
        "AggregateError",
      ].includes(error.name)
        ? error.name
        : "Unknown",
    stage,
    environment,
    correlation_id: correlationId,
    category: provider
      ? "provider"
      : domainCode
        ? "onboarding_state"
        : internal
          ? "configuration"
          : databaseCode
            ? "database"
            : transport
              ? "transport"
              : "processing",
    code:
      providerCode ??
      domainCode ??
      internal ??
      databaseCode ??
      transport ??
      "PROCESSING_UNCONFIRMED",
    retry: provider
      ? error.retryable
      : !internal &&
        !domainCode &&
        !["42P01", "42703", "42501", "28P01"].includes(code),
    result: "unconfirmed",
    ...(fields ? { fields } : {}),
    ...(databaseReason ? { database_reason: databaseReason } : {}),
  };
}
