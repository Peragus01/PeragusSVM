import { OzavSandboxCustomerService } from "./application/ozav-sandbox-customer.js";
import { PostgresSandboxCustomerLinkRepository } from "./repositories/postgres-sandbox-customer-link.js";
import { assertSmokeTestSafety } from "./jobs/worker-smoke-test.js";
import { createSupabaseAuthenticator } from "./auth/supabase-authenticator.js";
import { PostgresCustomerRepository } from "./repositories/postgres-customer-repository.js";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

import { buildApp } from "./app.js";
import {
  ConfirmSolanaSettlementService,
  type SolanaSettlementConfirmer,
} from "./application/confirm-solana-settlement.js";
import {
  FundDevnetDemoWalletService,
  type DemoWalletFunder,
} from "./application/fund-devnet-demo-wallet.js";
import {
  GetOzavOnrampService,
  type OzavOnrampReader,
} from "./application/get-ozav-onramp.js";
import {
  GetSettlementAuditService,
  type SettlementAuditReader,
} from "./application/get-settlement-audit.js";
import {
  InitiateOzavOfframpService,
  type OzavOfframpInitiator,
} from "./application/initiate-ozav-offramp.js";
import {
  PrepareSolanaSettlementService,
  type SolanaSettlementPreparer,
} from "./application/prepare-solana-settlement.js";
import {
  PrepareSolanaRollbackDemoService,
  type SolanaRollbackDemoPreparer,
} from "./application/prepare-solana-rollback-demo.js";
import {
  SimulateSandboxPixPaymentService,
  type SandboxPixPaymentSimulator,
} from "./application/simulate-sandbox-pix-payment.js";
import { TransitionSettlementService } from "./application/transition-settlement.js";
import { getEnv } from "./config/env.js";
import { createDatabasePool } from "./database/pool.js";
import {
  createJobQueue,
  ensureSettlementQueues,
  PgBossOzavOfframpReconciliationScheduler,
  PgBossOzavReconciliationScheduler,
  PgBossSettlementJobPublisher,
} from "./jobs/pg-boss.js";
import type { OzavOfframpReconciliationScheduler } from "./jobs/ozav-offramp-reconciliation.js";
import {
  NoopSettlementJobPublisher,
  type SettlementJobPublisher,
} from "./jobs/settlement-orchestration.js";
import { loadConfiguredSolanaAuthority } from "./providers/local-solana-authority.js";
import { OzavClient } from "./providers/ozav-client.js";
import { InMemorySettlementRepository } from "./repositories/in-memory-settlement-repository.js";
import { PostgresOzavOfframpIntentRepository } from "./repositories/postgres-ozav-offramp-intent-repository.js";
import { PostgresOzavOnrampIntentRepository } from "./repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresOzavOnrampRepository } from "./repositories/postgres-ozav-onramp-repository.js";
import { PostgresSettlementRepository } from "./repositories/postgres-settlement-repository.js";
import { PostgresSolanaContingencyReserveRepository } from "./repositories/solana-contingency-reserve-repository.js";
import { PostgresSolanaSettlementConfirmationRepository } from "./repositories/solana-settlement-confirmation-repository.js";
import { PostgresSolanaSettlementPreparationRepository } from "./repositories/solana-settlement-preparation-repository.js";
import type { SettlementRepository } from "./repositories/settlement-repository.js";

const env = getEnv();

// The executable API has no unauthenticated fallback. buildApp supports isolated
// dependency-injected tests, but the deployed server must always enforce access.
if (!env.DATABASE_URL || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
  throw new Error("DATABASE_URL, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required for the authenticated API");
}
if (env.OZAV_ONRAMP_WRITES_ENABLED || env.OZAV_OFFRAMP_WRITES_ENABLED
  || env.SOLANA_COSIGNING_ENABLED || env.SOLANA_CONTINGENCY_RESERVE_ENABLED
  || env.PERAGUS_SANDBOX_DEMO_ENABLED) {
  throw new Error("Authenticated customer onboarding requires financial and demo flags disabled until per-customer routing is implemented");
}
if (env.SETTLEMENT_DRAFTS_ENABLED || env.OZAV_SANDBOX_CUSTOMERS_ENABLED) {
  assertSmokeTestSafety(env);
  if (env.SUPABASE_URL !== "https://lybdkqkbwlfwvmmvstzi.supabase.co") {
    throw new Error("Settlement drafts require the pinned staging Auth project");
  }
}
if (env.OZAV_SANDBOX_CUSTOMERS_ENABLED && !env.OZAV_API_KEY) {
  throw new Error("OZAV_API_KEY sandbox key is required for customer fixture onboarding");
}
const authenticate = createSupabaseAuthenticator(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);

let pool: Pool | undefined;
let boss: PgBoss | undefined;
let settlementRepository: SettlementRepository;
let demoWalletFunder: DemoWalletFunder | undefined;
let ozavOnrampReader: OzavOnrampReader | undefined;
let sandboxPixPaymentSimulator:
  | SandboxPixPaymentSimulator
  | undefined;
let settlementAuditReader:
  | SettlementAuditReader
  | undefined;
let ozavOfframpInitiator:
  | OzavOfframpInitiator
  | undefined;
let ozavOfframpReconciliationScheduler:
  | OzavOfframpReconciliationScheduler
  | undefined;
let solanaSettlementPreparer:
  | SolanaSettlementPreparer
  | undefined;
let solanaRollbackDemoPreparer:
  | SolanaRollbackDemoPreparer
  | undefined;
let solanaSettlementConfirmer:
  | SolanaSettlementConfirmer
  | undefined;
let settlementJobPublisher: SettlementJobPublisher =
  new NoopSettlementJobPublisher();

if (env.DATABASE_URL) {
  const databasePool = createDatabasePool(
    env.DATABASE_URL,
    env.DATABASE_SSL,
  );

  const jobQueue = createJobQueue(
    env.DATABASE_URL,
    env.DATABASE_SSL,
  );

  jobQueue.on("error", (error) => {
    console.error("PG-BOSS ERROR:", error);
  });

  try {
    await jobQueue.start();
    await ensureSettlementQueues(jobQueue);
  } catch (error) {
    await jobQueue.stop().catch(() => undefined);
    await databasePool.end().catch(() => undefined);
    throw error;
  }

  pool = databasePool;
  boss = jobQueue;
  ozavOfframpReconciliationScheduler =
    new PgBossOzavOfframpReconciliationScheduler(
      jobQueue,
      env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
      env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
    );
  const ozavReconciliationScheduler =
    new PgBossOzavReconciliationScheduler(
      jobQueue,
      env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
      env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
    );

  settlementRepository =
    new PostgresSettlementRepository(databasePool);

  const onrampIntents =
    new PostgresOzavOnrampIntentRepository(databasePool);
  const onramps =
    new PostgresOzavOnrampRepository(databasePool);
  const offramps =
    new PostgresOzavOfframpIntentRepository(databasePool);
  const contingencyReserves =
    new PostgresSolanaContingencyReserveRepository(
      databasePool,
    );
  const solanaSettlements =
    new PostgresSolanaSettlementConfirmationRepository(
      databasePool,
    );

  ozavOnrampReader = new GetOzavOnrampService({
    settlements: settlementRepository,
    intents: onrampIntents,
    onramps,
  });

  settlementAuditReader = new GetSettlementAuditService({
    settlements: settlementRepository,
    onrampIntents,
    onramps,
    contingencyReserves,
    solanaSettlements,
    offramps,
  });

  if (env.PERAGUS_SANDBOX_DEMO_ENABLED) {
    sandboxPixPaymentSimulator =
      new SimulateSandboxPixPaymentService({
        settlements: settlementRepository,
        onramps,
        client: new OzavClient({
          apiKey: env.OZAV_API_KEY!,
          timeoutMs: 10_000,
          attempts: 1,
        }),
        reconciliationScheduler:
          ozavReconciliationScheduler,
      });
  }

  if (env.OZAV_OFFRAMP_WRITES_ENABLED) {
    if (
      env.NODE_ENV === "production"
      && !env.PERAGUS_SANDBOX_DEMO_ENABLED
    ) {
      throw new Error(
        "OZAV sandbox off-ramp writes cannot be enabled in production",
      );
    }

    const ozavClient = new OzavClient({
      apiKey: env.OZAV_API_KEY!,
    });

    ozavOfframpInitiator =
      new InitiateOzavOfframpService({
        client: ozavClient,
        intents: offramps,
        onramps,
        settlements: settlementRepository,
        transitioner:
          new TransitionSettlementService(
            settlementRepository,
          ),
        customerId: env.OZAV_CUSTOMER_ID!,
        walletId: env.OZAV_WALLET_ID!,
        spreadBps: env.OZAV_SPREAD_BPS,
      });
  }

  if (env.SOLANA_COSIGNING_ENABLED) {
    if (
      env.NODE_ENV === "production"
      && !env.PERAGUS_SANDBOX_DEMO_ENABLED
    ) {
      throw new Error(
        "Local Solana keypair signers cannot be enabled in production; configure an HSM/KMS signer adapter",
      );
    }

    if (
      !env.SOLANA_SOURCE_MINT
      || !env.SOLANA_DESTINATION_MINT
    ) {
      throw new Error(
        "Solana cosigning configuration is incomplete",
      );
    }

    const solanaConnection = new Connection(
      env.SOLANA_RPC_URL,
      "confirmed",
    );
    const solanaProgramId = new PublicKey(
      env.SOLANA_PROGRAM_ID,
    );
    const sourceMint = new PublicKey(
      env.SOLANA_SOURCE_MINT,
    );
    const destinationMint = new PublicKey(
      env.SOLANA_DESTINATION_MINT,
    );
    const attestationAuthority = loadConfiguredSolanaAuthority({
      filePath: env.SOLANA_ATTESTATION_KEYPAIR_PATH,
      keypairBase64: env.SOLANA_ATTESTATION_KEYPAIR_BASE64,
      label: "SOLANA_ATTESTATION",
    });
    const liquidityAuthority = loadConfiguredSolanaAuthority({
      filePath: env.SOLANA_LIQUIDITY_KEYPAIR_PATH,
      keypairBase64: env.SOLANA_LIQUIDITY_KEYPAIR_BASE64,
      label: "SOLANA_LIQUIDITY",
    });

    if (env.PERAGUS_SANDBOX_DEMO_ENABLED) {
      const fundingAuthority =
        loadConfiguredSolanaAuthority({
          filePath: env.SOLANA_FEE_PAYER_KEYPAIR_PATH,
          keypairBase64: env.SOLANA_FEE_PAYER_KEYPAIR_BASE64,
          label: "SOLANA_FEE_PAYER",
        });
      demoWalletFunder =
        new FundDevnetDemoWalletService({
          connection: solanaConnection,
          sourceMint,
          fundingAuthority,
        });

      solanaRollbackDemoPreparer =
        new PrepareSolanaRollbackDemoService({
          settlements: settlementRepository,
          connection: solanaConnection,
          programId: solanaProgramId,
          sourceMint,
          destinationMint,
          attestationAuthority,
          liquidityAuthority,
        });
    }

    solanaSettlementPreparer =
      new PrepareSolanaSettlementService({
        settlements: settlementRepository,
        preparations:
          new PostgresSolanaSettlementPreparationRepository(
            databasePool,
          ),
        connection: solanaConnection,
        programId: solanaProgramId,
        sourceMint,
        destinationMint,
        attestationAuthority,
        liquidityAuthority,
      });

    solanaSettlementConfirmer =
      new ConfirmSolanaSettlementService({
        settlements: settlementRepository,
        confirmations: solanaSettlements,
        connection: solanaConnection,
        programId: solanaProgramId,
        sourceMint,
        destinationMint,
        attestationAuthority:
          attestationAuthority.publicKey,
        liquidityAuthority:
          liquidityAuthority.publicKey,
      });
  }

  settlementJobPublisher =
    new PgBossSettlementJobPublisher(jobQueue);
} else {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is required when NODE_ENV=production",
    );
  }

  settlementRepository =
    new InMemorySettlementRepository();
}

const app = await buildApp({
  customerAccess: { authenticate, customers: new PostgresCustomerRepository(pool!) },
  ...(env.OZAV_SANDBOX_CUSTOMERS_ENABLED ? {
    ozavSandboxCustomerService: new OzavSandboxCustomerService(
      new PostgresSandboxCustomerLinkRepository(pool!), new OzavClient({ apiKey: env.OZAV_API_KEY!, attempts: 1 }),
    ),
  } : {}),
  ...(env.SETTLEMENT_DRAFTS_ENABLED ? {
    customerDraftRepository: (customerId: string) => PostgresSettlementRepository.forCustomerDrafts(pool!, customerId),
  } : {}),
  logger: {
    redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    level: env.LOG_LEVEL,
  },
  settlementRepository,
  settlementJobPublisher,
  demoWalletFunder,
  ozavOnrampReader,
  sandboxPixPaymentSimulator,
  settlementAuditReader,
  ozavOfframpInitiator,
  ozavOfframpReconciliationScheduler,
  solanaSettlementPreparer,
  solanaRollbackDemoPreparer,
  solanaSettlementConfirmer,
});

const databasePool = pool;
const jobQueue = boss;

app.addHook("onClose", async () => {
  if (jobQueue) {
    await jobQueue.stop();
  }

  if (databasePool) {
    await databasePool.end();
  }
});

if (!pool) {
  app.log.warn(
    "DATABASE_URL is not configured; using volatile in-memory storage",
  );
}

let shuttingDown = false;

async function shutdown(
  signal: NodeJS.Signals,
): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  app.log.info(
    { signal },
    "Shutting down Peragus backend",
  );

  await app.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
