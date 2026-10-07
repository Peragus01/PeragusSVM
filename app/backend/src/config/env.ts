import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
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
  SOLANA_SOURCE_MINT: z.string().min(32).max(44).optional(),
  SOLANA_DESTINATION_MINT: z.string().min(32).max(44).optional(),
  SOLANA_ATTESTATION_KEYPAIR_PATH: z
    .string()
    .min(1)
    .optional(),
  SOLANA_LIQUIDITY_KEYPAIR_PATH: z
    .string()
    .min(1)
    .optional(),
}).superRefine((env, context) => {
  if (!env.SOLANA_COSIGNING_ENABLED) {
    return;
  }

  for (const field of [
    "SOLANA_SOURCE_MINT",
    "SOLANA_DESTINATION_MINT",
    "SOLANA_ATTESTATION_KEYPAIR_PATH",
    "SOLANA_LIQUIDITY_KEYPAIR_PATH",
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
