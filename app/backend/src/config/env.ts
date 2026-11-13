import { parseWithdrawalOperators } from "../withdrawals/operator-approvals.js";
import "dotenv/config";
import { moneyPathsNotLiveReady, providerKeyMatchesMode } from "./money-environment.js";
import { purchaseLimits } from "../purchases/operation-status.js";

import { z } from "zod";
import { parseLegalRequiredDocuments } from "../legal/legal-acceptance.js";

export const envSchema = z
  .object({
    PERAGUS_DEPLOYMENT_ENV: z
      .enum(["staging", "production"])
      .default("staging"),
    SANDBOX_WITHDRAWAL_CLOSURE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    API_RATE_LIMITS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    INVITE_EMAIL_OUTBOX_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    INVITE_EMAIL_ENCRYPTION_KEY: z.string().optional(),
    INVITE_EMAIL_FROM: z.email().optional(),
    INVITE_EMAIL_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/=_-]{16,256}$/)
      .optional(),
    INVITE_EMAIL_ENCRYPTION_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .optional(),
    PILOT_INVITE_EMAIL_HASH_KEY: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    PILOT_INVITES_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Operator + trusted-person e-mail alerts (Task 17): the worker drains the outbox and runs
    // the stuck-operation scanner only when enabled. Recipients are validated, never logged.
    OPERATOR_NOTIFICATIONS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    OPERATOR_ALERT_EMAIL: z.email().optional(),
    TRUSTED_ALERT_EMAIL: z.email().optional(),
    OPERATOR_NOTIFICATIONS_FROM: z.email().optional(),
    CUSTOMER_RECONCILIATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MANUAL_REFUNDS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SANDBOX_WITHDRAWAL_RECOVERY_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SANDBOX_WITHDRAWAL_EXECUTION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    WITHDRAWAL_OPERATOR_APPROVALS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Money-moving operator actions need a TOTP verified at most this long ago (<= 300 s).
    OPERATOR_MFA_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(300).default(300),
    // Minimum seconds between a withdrawal approval and its execution.
    OPERATOR_EXECUTION_MIN_DELAY_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(86_400)
      .default(900),
    // How many USDT units (6 decimals) the on-chain delivery may fall below the locked amount
    // and still be verified: OZAV deducts the network fee from the sent USDT. Default 0.10 USDT.
    USDT_DELIVERY_TOLERANCE_UNITS: z
      .string()
      .regex(/^(0|[1-9]\d{0,8})$/)
      .default("100000")
      .transform((value) => BigInt(value)),
    // true: the executor must be a different operator from the approver.
    OPERATOR_FOUR_EYES_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    WITHDRAWAL_OPERATOR_USER_IDS: z
      .string()
      .default("")
      .transform((value, ctx) => {
        try {
          return parseWithdrawalOperators(value);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Expected up to five comma-separated operator UUIDs",
          });
          return z.NEVER;
        }
      }),
    CUSTOMER_WITHDRAWAL_REQUESTS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_SANDBOX_PIX_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    CUSTOMER_PURCHASE_INTENTS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_QUOTES_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Purchase range (BRL, decimal strings) and global open-operation cap.
    PURCHASE_MIN_BRL: z
      .string()
      .regex(/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/)
      .default("1000.00"),
    PURCHASE_MAX_BRL: z
      .string()
      .regex(/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/)
      .default("1000.00"),
    PURCHASE_MAX_OPEN_GLOBAL: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(1),
    CUSTOMER_WALLET_LINKING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_ONBOARDING_STATUS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_SCREENINGS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_DOCUMENTS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_DOCUMENT_UPLOAD_ORIGINS: z.string().default(""),
    CUSTOMER_VERIFICATIONS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_VERIFICATION_SIMULATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_SUBMISSION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_TERMS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_ONBOARDING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_DATA_ENCRYPTION_KEY: z.string().optional(),
    CUSTOMER_DATA_ENCRYPTION_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .default("v1"),
    CUSTOMER_WEBHOOKS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CUSTOMER_WEBHOOK_SECRET: z
      .string()
      .max(2048)
      .regex(/^ozav_whsec_\S+$/)
      .optional(),
    OZAV_SANDBOX_CUSTOMERS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SETTLEMENT_DRAFTS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
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
    WORKER_SMOKE_TEST_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
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
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(25).default(3),
    OZAV_API_KEY: z
      .string()
      .regex(/^ozav_sk_(test|live)_[A-Za-z0-9_-]+$/)
      .optional(),
    SOLANA_USDT_MINT: z.string().min(32).max(44).optional(),
    // JSON {"terms":{"version","sha256"},"privacy":{...},"refund":{...}}; shape is
    // validated below, and the server refuses to start customer access without it.
    // Reverse-proxy hops in front of the API (Railway: 1). request.ip honors exactly this many.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(0),
    LEGAL_REQUIRED_DOCUMENTS: z.string().min(1).optional(),
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
    OZAV_SOURCE_DECIMALS: z.coerce.number().int().min(0).max(9).default(6),
    OZAV_SPREAD_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
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
    SOLANA_RPC_URL: z.string().url().default("http://127.0.0.1:18899"),
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
    SOLANA_ATTESTATION_KEYPAIR_PATH: z.string().min(1).optional(),
    SOLANA_ATTESTATION_KEYPAIR_BASE64: z.string().min(1).optional(),
    SOLANA_LIQUIDITY_KEYPAIR_PATH: z.string().min(1).optional(),
    SOLANA_LIQUIDITY_KEYPAIR_BASE64: z.string().min(1).optional(),
    SOLANA_FEE_PAYER_KEYPAIR_PATH: z.string().min(1).optional(),
    SOLANA_FEE_PAYER_KEYPAIR_BASE64: z.string().min(1).optional(),
  })
  .superRefine((env, context) => {
    if (env.LEGAL_REQUIRED_DOCUMENTS !== undefined) {
      try {
        parseLegalRequiredDocuments(env.LEGAL_REQUIRED_DOCUMENTS);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["LEGAL_REQUIRED_DOCUMENTS"],
          message: "LEGAL_REQUIRED_DOCUMENTS_INVALID",
        });
      }
    }
    const expected =
      env.PERAGUS_DEPLOYMENT_ENV === "production" ? "live" : "test";
    // Sandbox money executors stay off in live until their live paths exist
    // (the customer Pix path and, since Task 10, the withdrawal execution are live-safe).
    for (const flag of moneyPathsNotLiveReady(expected, env)) {
      context.addIssue({
        code: "custom",
        path: [flag],
        message: `MONEY_PATH_NOT_LIVE_READY: ${flag}`,
      });
    }
    {
      const { minCents, maxCents } = purchaseLimits(env);
      if (minCents <= 0n || maxCents > 1_000_000n || minCents > maxCents)
        context.addIssue({
          code: "custom",
          path: ["PURCHASE_MAX_BRL"],
          message:
            "PURCHASE_MIN_BRL must be positive and not above PURCHASE_MAX_BRL (at most 10000.00)",
        });
    }
    if (env.OZAV_API_KEY) {
      if (!providerKeyMatchesMode(env.OZAV_API_KEY, expected)) {
        context.addIssue({
          code: "custom",
          path: ["OZAV_API_KEY"],
          message: `OZAV_API_KEY must be an ozav_sk_${expected}_ key for ${env.PERAGUS_DEPLOYMENT_ENV}`,
        });
      }
    }
    if (
      env.PERAGUS_DEPLOYMENT_ENV === "staging" &&
      !env.SOLANA_USDT_MINT &&
      (env.CUSTOMER_QUOTES_ENABLED ||
        env.CUSTOMER_PURCHASE_INTENTS_ENABLED ||
        env.CUSTOMER_SANDBOX_PIX_ENABLED ||
        env.SANDBOX_WITHDRAWAL_EXECUTION_ENABLED)
    ) {
      context.addIssue({
        code: "custom",
        path: ["SOLANA_USDT_MINT"],
        message: "SOLANA_USDT_MINT is required when purchase flows are enabled",
      });
    }
    if (env.INVITE_EMAIL_OUTBOX_ENABLED) {
      const key = env.INVITE_EMAIL_ENCRYPTION_KEY ?? "";
      const decoded = Buffer.from(key, "base64");
      if (
        decoded.length !== 32 ||
        decoded.toString("base64") !== key ||
        !env.INVITE_EMAIL_ENCRYPTION_KEY_ID ||
        !env.INVITE_EMAIL_FROM?.endsWith("@peragus.com.br") ||
        !env.PILOT_INVITE_EMAIL_HASH_KEY ||
        !env.DATABASE_URL ||
        env.SUPABASE_URL !==
          (env.PERAGUS_DEPLOYMENT_ENV === "production"
            ? "https://athwkklyvnaetotmancy.supabase.co"
            : "https://lybdkqkbwlfwvmmvstzi.supabase.co") ||
        env.OZAV_ONRAMP_WRITES_ENABLED ||
        env.OZAV_OFFRAMP_WRITES_ENABLED ||
        env.SOLANA_COSIGNING_ENABLED ||
        env.SOLANA_CONTINGENCY_RESERVE_ENABLED ||
        env.PERAGUS_SANDBOX_DEMO_ENABLED
      ) {
        context.addIssue({
          code: "custom",
          path: ["INVITE_EMAIL_OUTBOX_ENABLED"],
          message:
            "Invitation outbox requires the selected Auth project and valid encryption configuration",
        });
      }
    }
    if (env.OPERATOR_NOTIFICATIONS_ENABLED) {
      // Messages name the variable only, never its value.
      if (!env.OPERATOR_ALERT_EMAIL)
        context.addIssue({ code: "custom", path: ["OPERATOR_ALERT_EMAIL"], message: "OPERATOR_ALERT_EMAIL is required when operator notifications are enabled" });
      if (!env.TRUSTED_ALERT_EMAIL)
        context.addIssue({ code: "custom", path: ["TRUSTED_ALERT_EMAIL"], message: "TRUSTED_ALERT_EMAIL is required when operator notifications are enabled" });
      if (env.OPERATOR_ALERT_EMAIL && env.TRUSTED_ALERT_EMAIL
        && env.OPERATOR_ALERT_EMAIL.toLowerCase() === env.TRUSTED_ALERT_EMAIL.toLowerCase())
        context.addIssue({ code: "custom", path: ["TRUSTED_ALERT_EMAIL"], message: "TRUSTED_ALERT_EMAIL must differ from OPERATOR_ALERT_EMAIL" });
      if (!env.OPERATOR_NOTIFICATIONS_FROM?.toLowerCase().endsWith("@peragus.com.br"))
        context.addIssue({ code: "custom", path: ["OPERATOR_NOTIFICATIONS_FROM"], message: "OPERATOR_NOTIFICATIONS_FROM must be an @peragus.com.br sender" });
      if (!env.DATABASE_URL)
        context.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL is required when operator notifications are enabled" });
    }
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
          message: `${label} must use either KEYPAIR_PATH or KEYPAIR_BASE64, not both`,
        });
      } else if (required && !pathValue && !base64Value) {
        context.addIssue({
          code: "custom",
          path: [`${label}_KEYPAIR_BASE64`],
          message: `${label}_KEYPAIR_PATH or ${label}_KEYPAIR_BASE64 is required`,
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
            message: `${field} is required when PERAGUS_SANDBOX_DEMO_ENABLED=true`,
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
            message: `${field} must be true when PERAGUS_SANDBOX_DEMO_ENABLED=true`,
          });
        }
      }

      if (!env.SOLANA_RPC_URL.toLowerCase().includes("devnet")) {
        context.addIssue({
          code: "custom",
          path: ["SOLANA_RPC_URL"],
          message: "PERAGUS_SANDBOX_DEMO_ENABLED requires a Solana Devnet RPC",
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
            message: `${field} is required when OZAV_OFFRAMP_WRITES_ENABLED=true`,
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
            message: `${field} is required when SOLANA_COSIGNING_ENABLED=true`,
          });
        }
      }
    }

    if (env.SOLANA_CONTINGENCY_RESERVE_ENABLED) {
      for (const field of ["SOLANA_DESTINATION_MINT"] as const) {
        if (!env[field]) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is required when SOLANA_CONTINGENCY_RESERVE_ENABLED=true`,
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
      env.PERAGUS_SANDBOX_DEMO_ENABLED ||
        env.SOLANA_COSIGNING_ENABLED ||
        env.SOLANA_CONTINGENCY_RESERVE_ENABLED,
    );
    validateSigner(
      env.SOLANA_LIQUIDITY_KEYPAIR_PATH,
      env.SOLANA_LIQUIDITY_KEYPAIR_BASE64,
      "SOLANA_LIQUIDITY",
      env.PERAGUS_SANDBOX_DEMO_ENABLED ||
        env.SOLANA_COSIGNING_ENABLED ||
        env.SOLANA_CONTINGENCY_RESERVE_ENABLED,
    );
    validateSigner(
      env.SOLANA_FEE_PAYER_KEYPAIR_PATH,
      env.SOLANA_FEE_PAYER_KEYPAIR_BASE64,
      "SOLANA_FEE_PAYER",
      env.PERAGUS_SANDBOX_DEMO_ENABLED ||
        env.SOLANA_CONTINGENCY_RESERVE_ENABLED,
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
    const notLiveReady = result.error.issues
      .filter((issue) => issue.message.startsWith("MONEY_PATH_NOT_LIVE_READY"))
      .map((issue) => String(issue.path[0]));
    if (notLiveReady.length)
      throw Object.assign(
        new Error(`MONEY_PATH_NOT_LIVE_READY: ${notLiveReady.join(",")}`),
        { code: "MONEY_PATH_NOT_LIVE_READY", fields: notLiveReady },
      );
    const fields = [
      ...new Set(
        result.error.issues
          .map((issue) => String(issue.path[0] ?? "UNKNOWN"))
          .filter((field) => /^[A-Z0-9_]+$/.test(field)),
      ),
    ];
    throw Object.assign(new Error("ENVIRONMENT_CONFIGURATION_INVALID"), {
      code: "ENVIRONMENT_CONFIGURATION_INVALID",
      fields,
    });
  }

  cachedEnv = result.data;
  return cachedEnv;
}
