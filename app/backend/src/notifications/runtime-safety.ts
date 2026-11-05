// Deployment location and provider mode are separate: both locations run only
// controlled synthetic onboarding until a separately reviewed live integration.
const projects = {
  staging: "lybdkqkbwlfwvmmvstzi",
  production: "athwkklyvnaetotmancy",
} as const;
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
  const mode = runtime.ONBOARDING_EMAIL_DEPLOYMENT_ENV;
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
  const direct =
    db.hostname === `db.${project}.supabase.co` &&
    decodeURIComponent(db.username) === "postgres";
  const pooler =
    /^aws-[0-9]+-sa-east-1\.pooler\.supabase\.com$/.test(db.hostname) &&
    decodeURIComponent(db.username) === `postgres.${project}`;
  if (
    (!direct && !pooler) ||
    !["", "5432"].includes(db.port) ||
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    env.SUPABASE_URL !== `https://${project}.supabase.co`
  )
    throw Error("ONBOARDING_DATABASE_MISMATCH");
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
export function notificationFailure(
  error: unknown,
  stage: string,
  environment: string,
  correlationId: string,
) {
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
  const internal =
    error instanceof Error &&
    /^(ONBOARDING_[A-Z_]+|ENVIRONMENT_CONFIGURATION_INVALID)$/.test(
      error.message,
    )
      ? error.message
      : undefined;
  const databaseCode =
    /^(42P01|42703|42501|28P01|08001|08006|53300|57P01|40001|40P01)$/.test(code)
      ? code
      : undefined;
  const transport = [
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "ECONNRESET",
  ].includes(code)
    ? code
    : undefined;
  return {
    event: "onboarding_email_failure",
    stage,
    environment,
    correlation_id: correlationId,
    category: internal
      ? "configuration"
      : databaseCode
        ? "database"
        : transport
          ? "transport"
          : "processing",
    code: internal ?? databaseCode ?? transport ?? "PROCESSING_UNCONFIRMED",
    retry: !internal && !["42P01", "42703", "42501", "28P01"].includes(code),
    result: "unconfirmed",
    ...(fields ? { fields } : {}),
  };
}
