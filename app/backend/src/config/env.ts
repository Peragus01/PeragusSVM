import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  CUSTOMER_VERIFICATIONS_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CUSTOMER_VERIFICATION_SIMULATION_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CUSTOMER_SUBMISSION_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CUSTOMER_TERMS_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CUSTOMER_ONBOARDING_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CUSTOMER_DATA_ENCRYPTION_KEY: z.string().optional(),
  CUSTOMER_DATA_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default("v1"),
  CUSTOMER_WEBHOOKS_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CUSTOMER_WEBHOOK_SECRET: z.string().max(2048).regex(/^ozav_whsec_\S+$/).optional(),
  OZAV_SANDBOX_CUSTOMERS_ENABLED: z.enum(["true", "false"])
    .default("false").transform(value => value === "true"),
  SETTLEMENT_DRAFTS_ENABLED: z.enum(["true", "false"])
    .default("false").transform(value => value === "true"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  PERAGUS_SANDBOX_DEMO_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  WORKER_SMOKE_TEST_ENABLED: z.enum(["true", "false"])
    .default("false").transform((value) => value === "true"),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  JOB_POLL_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .default(2),
  JOB_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(25)
    .default(3),
  OZAV_API_KEY: z
    .string()
    .regex(/^ozav_sk_test_[A-Za-z0-9_-]+$/)
    .optional(),
  OZAV_ONRAMP_WRITES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  OZAV_OFFRAMP_WRITES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  OZAV_CUSTOMER_ID: z
    .string()
    .regex(/^ozav_cus_[A-Za-z0-9_]+$/)
    .optional(),
  OZAV_WALLET_ID: z
    .string()
    .regex(/^ozav_wal_[A-Za-z0-9_]+$/)
    .optional(),
  OZAV_SOURCE_DECIMALS: z.coerce
    .number()
    .int()
    .min(0)
    .max(9)
    .default(6),
  OZAV_SPREAD_BPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0),
  OZAV_MIN_SOURCE_AMOUNT_BRL: z
    .string()
    .regex(/^\d+(?:\.\d{1,2})?$/)
    .default("400"),
  OZAV_RECONCILIATION_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_600)
    .default(30),
  OZAV_RECONCILIATION_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(120),
  SOLANA_RPC_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:18899"),
  SOLANA_PROGRAM_ID: z
    .string()
    .min(32)
    .default("6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w"),
  SOLANA_COSIGNING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SOLANA_CONTINGENCY_RESERVE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SOLANA_CONTINGENCY_FALLBACK_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(300),
  SOLANA_SOURCE_MINT: z.string().min(32).max(44).optional(),
  SOLANA_DESTINATION_MINT: z.string().min(32).max(44).optional(),
  SOLANA_ATTESTATION_KEYPAIR_PATH: z
    .string()
    .min(1)
    .optional(),
  SOLANA_ATTESTATION_KEYPAIR_BASE64: z
    .string()
    .min(1)
    .optional(),
  SOLANA_LIQUIDITY_KEYPAIR_PATH: z
    .string()
    .min(1)
    .optional(),
  SOLANA_LIQUIDITY_KEYPAIR_BASE64: z
    .string()
    .min(1)
    .optional(),
  SOLANA_FEE_PAYER_KEYPAIR_PATH: z
    .string()
    .min(1)
    .optional(),
  SOLANA_FEE_PAYER_KEYPAIR_BASE64: z
    .string()
    .min(1)
    .optional(),
}).superRefine((env, context) => {
  const validateSigner = (
    pathValue: string | undefined,
    base64Value: string | undefined,
    label: string,
    required: boolean,
  ) => {
    if (pathValue && base64Value) {
      context.addIssue({
        code: "custom",
        path: [`${label}_KEYPAIR_BASE64`],
        message:
          `${label} must use either KEYPAIR_PATH or KEYPAIR_BASE64, not both`,
      });
    } else if (required && !pathValue && !base64Value) {
      context.addIssue({
        code: "custom",
        path: [`${label}_KEYPAIR_BASE64`],
        message:
          `${label}_KEYPAIR_PATH or ${label}_KEYPAIR_BASE64 is required`,
      });
    }
  };

  if (env.PERAGUS_SANDBOX_DEMO_ENABLED) {
    for (const field of [
      "DATABASE_URL",
      "OZAV_API_KEY",
      "OZAV_CUSTOMER_ID",
      "OZAV_WALLET_ID",
      "SOLANA_SOURCE_MINT",
      "SOLANA_DESTINATION_MINT",
    ] as const) {
      if (!env[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            `${field} is required when PERAGUS_SANDBOX_DEMO_ENABLED=true`,
        });
      }
    }

    for (const field of [
      "OZAV_ONRAMP_WRITES_ENABLED",
      "OZAV_OFFRAMP_WRITES_ENABLED",
      "SOLANA_COSIGNING_ENABLED",
      "SOLANA_CONTINGENCY_RESERVE_ENABLED",
    ] as const) {
      if (!env[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            `${field} must be true when PERAGUS_SANDBOX_DEMO_ENABLED=true`,
        });
      }
    }

    if (
      !env.SOLANA_RPC_URL
        .toLowerCase()
        .includes("devnet")
    ) {
      context.addIssue({
        code: "custom",
        path: ["SOLANA_RPC_URL"],
        message:
          "PERAGUS_SANDBOX_DEMO_ENABLED requires a Solana Devnet RPC",
      });
    }
  }

  if (env.OZAV_OFFRAMP_WRITES_ENABLED) {
    for (const field of [
      "OZAV_API_KEY",
      "OZAV_CUSTOMER_ID",
      "OZAV_WALLET_ID",
    ] as const) {
      if (!env[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            `${field} is required when OZAV_OFFRAMP_WRITES_ENABLED=true`,
        });
      }
    }
  }

  if (env.SOLANA_COSIGNING_ENABLED) {
    for (const field of [
      "SOLANA_SOURCE_MINT",
      "SOLANA_DESTINATION_MINT",
    ] as const) {
      if (!env[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            `${field} is required when SOLANA_COSIGNING_ENABLED=true`,
        });
      }
    }
  }

  if (env.SOLANA_CONTINGENCY_RESERVE_ENABLED) {
    for (const field of [
      "SOLANA_DESTINATION_MINT",
    ] as const) {
      if (!env[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            `${field} is required when SOLANA_CONTINGENCY_RESERVE_ENABLED=true`,
        });
      }
    }

    if (!env.OZAV_ONRAMP_WRITES_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["OZAV_ONRAMP_WRITES_ENABLED"],
        message:
          "OZAV_ONRAMP_WRITES_ENABLED must be true when the contingency reserve is enabled",
      });
    }
  }

  validateSigner(
    env.SOLANA_ATTESTATION_KEYPAIR_PATH,
    env.SOLANA_ATTESTATION_KEYPAIR_BASE64,
    "SOLANA_ATTESTATION",
    env.PERAGUS_SANDBOX_DEMO_ENABLED
      || env.SOLANA_COSIGNING_ENABLED
      || env.SOLANA_CONTINGENCY_RESERVE_ENABLED,
  );
  validateSigner(
    env.SOLANA_LIQUIDITY_KEYPAIR_PATH,
    env.SOLANA_LIQUIDITY_KEYPAIR_BASE64,
    "SOLANA_LIQUIDITY",
    env.PERAGUS_SANDBOX_DEMO_ENABLED
      || env.SOLANA_COSIGNING_ENABLED
      || env.SOLANA_CONTINGENCY_RESERVE_ENABLED,
  );
  validateSigner(
    env.SOLANA_FEE_PAYER_KEYPAIR_PATH,
    env.SOLANA_FEE_PAYER_KEYPAIR_BASE64,
    "SOLANA_FEE_PAYER",
    env.PERAGUS_SANDBOX_DEMO_ENABLED
      || env.SOLANA_CONTINGENCY_RESERVE_ENABLED,
  );
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}
