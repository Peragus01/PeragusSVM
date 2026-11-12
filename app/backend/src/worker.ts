import {CustomerReconciliationService,registerCustomerReconciliationWorker,assertCustomerReconciliationSafety,CUSTOMER_RECONCILIATION_QUEUE} from "./jobs/customer-reconciliation.js";
import {createCustomerReconciliationReader} from "./purchases/customer-reconciliation-reader.js";
import {createPurchaseProgression} from "./purchases/purchase-progression-factory.js";
import { assertSmokeTestSafety, registerWorkerSmokeTest } from "./jobs/worker-smoke-test.js";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";

import {
  EnsureSolanaContingencyReserveService,
  type OzavContingencyReserveGate,
} from "./application/ensure-solana-contingency-reserve.js";
import { ImportOzavOfframpEventsService } from "./application/import-ozav-offramp-events.js";
import { ImportOzavOnrampEventsService } from "./application/import-ozav-onramp-events.js";
import { InitiateOzavOnrampService } from "./application/initiate-ozav-onramp.js";
import { ReconcileOzavOnrampService } from "./application/reconcile-ozav-onramp.js";
import { ReconcileOzavOfframpService } from "./application/reconcile-ozav-offramp.js";
import {
  ResolveSolanaContingencyReserveService,
  type ContingencyReserveResolver,
} from "./application/resolve-solana-contingency-reserve.js";
import { TransitionSettlementService } from "./application/transition-settlement.js";
import { getEnv } from "./config/env.js";
import { assertDatabaseEnvironment, runMoneyEnvironmentBootChecks } from "./config/money-environment-boot.js";
import { moneyModeFor, resolveMoneyEnvironment } from "./config/money-environment.js";
import { createDatabasePool } from "./database/pool.js";
import { verifyDatabaseConnection } from "./database/readiness.js";
import { assertNotificationEnvironment, deploymentConfigurationAudit, notificationFailure } from "./notifications/runtime-safety.js";
import { randomUUID } from "node:crypto";
import {
  createJobQueue,
  ensureSettlementQueues,
  startJobQueue,
  PgBossOzavOfframpReconciliationScheduler,
  PgBossOzavReconciliationScheduler,
} from "./jobs/pg-boss.js";
import {
  OZAV_OFFRAMP_RECONCILIATION_QUEUE,
  OzavOfframpReconciliationJobHandler,
  type OzavOfframpReconciliationJob,
} from "./jobs/ozav-offramp-reconciliation.js";
import {
  OZAV_RECONCILIATION_QUEUE,
  OzavReconciliationJobHandler,
  shouldContinueOzavReconciliation,
  type OzavReconciliationJob,
} from "./jobs/ozav-reconciliation.js";
import {
  SETTLEMENT_ORCHESTRATION_QUEUE,
  SettlementOrchestrationHandler,
  type SettlementOrchestrationJob,
} from "./jobs/settlement-orchestration.js";
import { OzavClient } from "./providers/ozav-client.js";
import { loadConfiguredSolanaAuthority } from "./providers/local-solana-authority.js";
import { PostgresOzavOnrampIntentRepository } from "./repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresOzavOfframpIntentRepository } from "./repositories/postgres-ozav-offramp-intent-repository.js";
import { PostgresOzavOnrampRepository } from "./repositories/postgres-ozav-onramp-repository.js";
import { PostgresSettlementRepository } from "./repositories/postgres-settlement-repository.js";
import { PostgresSolanaContingencyReserveRepository } from "./repositories/solana-contingency-reserve-repository.js";

console.info(JSON.stringify(deploymentConfigurationAudit()));
const env = getEnv();
if (process.env.RAILWAY_ENVIRONMENT_NAME) {
  assertNotificationEnvironment(env, {...process.env, ONBOARDING_EMAIL_DEPLOYMENT_ENV: env.PERAGUS_DEPLOYMENT_ENV});
}

if (!env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required to start the worker",
  );
}

if (!env.OZAV_API_KEY) {
  throw new Error(
    "OZAV_API_KEY is required to start the worker",
  );
}

if (
  env.OZAV_ONRAMP_WRITES_ENABLED
  && (!env.OZAV_CUSTOMER_ID || !env.OZAV_WALLET_ID)
) {
  throw new Error(
    "OZAV_CUSTOMER_ID and OZAV_WALLET_ID are required "
    + "when OZAV on-ramp writes are enabled",
  );
}

if (env.WORKER_SMOKE_TEST_ENABLED) {
  assertSmokeTestSafety(env);
}

if(env.CUSTOMER_RECONCILIATION_ENABLED)assertCustomerReconciliationSafety(env);

const pool = createDatabasePool(
  env.DATABASE_URL,
  env.DATABASE_SSL,
);

const repository =
  new PostgresSettlementRepository(pool);

const ozavRepository =
  new PostgresOzavOnrampRepository(pool);

const ozavIntentRepository =
  new PostgresOzavOnrampIntentRepository(pool);

const ozavOfframpRepository =
  new PostgresOzavOfframpIntentRepository(pool);

let contingencyReserve:
  | OzavContingencyReserveGate
  | undefined;
let contingencyReserveResolver:
  | ContingencyReserveResolver
  | undefined;

if (env.SOLANA_CONTINGENCY_RESERVE_ENABLED) {
  if (
    env.NODE_ENV === "production"
    && !env.PERAGUS_SANDBOX_DEMO_ENABLED
  ) {
    throw new Error(
      "Local Solana contingency reserve signers cannot be enabled in production; configure an HSM/KMS signer adapter",
    );
  }

  const feePayer = loadConfiguredSolanaAuthority({
    filePath: env.SOLANA_FEE_PAYER_KEYPAIR_PATH,
    keypairBase64: env.SOLANA_FEE_PAYER_KEYPAIR_BASE64,
    label: "SOLANA_FEE_PAYER",
  });
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
  const connection = new Connection(
    env.SOLANA_RPC_URL,
    "confirmed",
  );
  const programId = new PublicKey(env.SOLANA_PROGRAM_ID);
  const destinationMint = new PublicKey(
    env.SOLANA_DESTINATION_MINT!,
  );
  const reserveRepository =
    new PostgresSolanaContingencyReserveRepository(pool);

  contingencyReserve =
    new EnsureSolanaContingencyReserveService({
      repository: reserveRepository,
      connection,
      programId,
      destinationMint,
      feePayer,
      attestationAuthority,
      liquidityAuthority,
      fallbackDelaySeconds:
        env.SOLANA_CONTINGENCY_FALLBACK_SECONDS,
    });

  contingencyReserveResolver =
    new ResolveSolanaContingencyReserveService({
      repository: reserveRepository,
      connection,
      programId,
      destinationMint,
      feePayer,
      attestationAuthority,
      liquidityAuthority,
    });
}

const ozavClient = new OzavClient({
  apiKey: env.OZAV_API_KEY,
  mode: moneyModeFor(env),
});

const ozavImporter = new ImportOzavOnrampEventsService({
  client: ozavClient,
  repository: ozavRepository,
  settlements: repository,
});

const ozavReconciler = new ReconcileOzavOnrampService({
  importer: ozavImporter,
  ozavRepository,
  settlements: repository,
  transitioner: new TransitionSettlementService(repository),
  ...(contingencyReserveResolver
    ? { contingencyReserveResolver }
    : {}),
});

const ozavOfframpImporter =
  new ImportOzavOfframpEventsService({
    client: ozavClient,
    repository: ozavOfframpRepository,
    settlements: repository,
  });

const ozavOfframpReconciler =
  new ReconcileOzavOfframpService({
    importer: ozavOfframpImporter,
    repository: ozavOfframpRepository,
    settlements: repository,
    transitioner:
      new TransitionSettlementService(repository),
  });

const ozavInitiator =
  env.OZAV_ONRAMP_WRITES_ENABLED
    ? new InitiateOzavOnrampService({
        client: ozavClient,
        intents: ozavIntentRepository,
        onramps: ozavRepository,
        settlements: repository,
        customerId: env.OZAV_CUSTOMER_ID!,
        walletId: env.OZAV_WALLET_ID!,
        sourceDecimals: env.OZAV_SOURCE_DECIMALS,
        spreadBps: env.OZAV_SPREAD_BPS,
        minimumSourceAmountBrl:
          env.OZAV_MIN_SOURCE_AMOUNT_BRL,
        ...(contingencyReserve
          ? { contingencyReserve }
          : {}),
      })
    : undefined;

const boss = createJobQueue(
  env.DATABASE_URL,
  env.DATABASE_SSL,
  4,
);

const ozavReconciliationScheduler =
  new PgBossOzavReconciliationScheduler(
    boss,
    env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
    env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
  );

const ozavOfframpReconciliationScheduler =
  new PgBossOzavOfframpReconciliationScheduler(
    boss,
    env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
    env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
  );

boss.on("error", (error) => {
  console.error(JSON.stringify({...notificationFailure(error, "queue", env.PERAGUS_DEPLOYMENT_ENV, randomUUID()), event: "job_queue_failure"}));
});

let shuttingDown = false;

async function shutdown(
  signal: NodeJS.Signals,
): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.info(
    JSON.stringify({
      event: "worker_shutdown",
      signal,
    }),
  );

  await boss.stop({
    graceful: true,
    timeout: 30_000,
  });

  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error(
        JSON.stringify({
          ...notificationFailure(
            error,
            "shutdown",
            env.PERAGUS_DEPLOYMENT_ENV,
            randomUUID(),
          ),
          event: "worker_shutdown_failure",
        }),
      );
      process.exitCode = 1;
    });
  });
}

try {
  await runMoneyEnvironmentBootChecks(
    env,
    {
      ozavClient: (apiKey, mode) => new OzavClient({ apiKey, mode, attempts: 1, timeoutMs: 5000 }),
      solanaConnection: (url) => new Connection(url, "confirmed"),
    },
    (e) => console.info(JSON.stringify(e)),
  );
  if (process.env.RAILWAY_ENVIRONMENT_NAME) await verifyDatabaseConnection(pool);
  await startJobQueue(boss);
  await ensureSettlementQueues(boss);
  if(env.CUSTOMER_RECONCILIATION_ENABLED){
    // Refuse to reconcile against a database recorded for the other money environment.
    await assertDatabaseEnvironment(pool,moneyModeFor(env));
    // GET-only reads; each observation progresses the purchase (system:reconciliation).
    const progression=createPurchaseProgression(pool,moneyModeFor(env),env,new OzavClient({apiKey:env.OZAV_API_KEY!,mode:moneyModeFor(env),attempts:1,timeoutMs:10000}));
    // Read-only on-chain delivery check (getParsedTransaction) for completed sends. Test deployments
    // without a configured USDT mint keep the previous behaviour (no delivery verification).
    const delivery=moneyModeFor(env)==="live" || env.SOLANA_USDT_MINT
      ?{usdtMint:resolveMoneyEnvironment(env).usdtMint,toleranceUnits:env.USDT_DELIVERY_TOLERANCE_UNITS,connection:new Connection(env.SOLANA_RPC_URL,"confirmed")}
      :undefined;
    await registerCustomerReconciliationWorker(boss,new CustomerReconciliationService(pool,createCustomerReconciliationReader(pool,env.OZAV_API_KEY!,moneyModeFor(env),undefined,progression,delivery),moneyModeFor(env)));
    console.info(JSON.stringify({event:"customer_reconciliation_configured",enabled:true,providerReadsOnly:true}));
  }else{
    await boss.unschedule(CUSTOMER_RECONCILIATION_QUEUE);
  }

  if (env.WORKER_SMOKE_TEST_ENABLED) {
    await registerWorkerSmokeTest(boss);
  }

  const handler =
    new SettlementOrchestrationHandler(repository);

  const ozavReconciliationHandler =
    new OzavReconciliationJobHandler(
      repository,
      ozavReconciler,
      ozavReconciliationScheduler,
    );

  const ozavOfframpReconciliationHandler =
    new OzavOfframpReconciliationJobHandler(
      repository,
      ozavOfframpRepository,
      ozavOfframpReconciler,
      ozavOfframpReconciliationScheduler,
    );

  await boss.work<SettlementOrchestrationJob>(
    SETTLEMENT_ORCHESTRATION_QUEUE,
    {
      pollingIntervalSeconds:
        env.JOB_POLL_INTERVAL_SECONDS,
      localConcurrency: env.JOB_CONCURRENCY,
    },
    async ([job]) => {
      if (!job) {
        throw new Error(
          "Settlement worker received an empty batch",
        );
      }

      const result = await handler.execute(job.data);
      const initiation = ozavInitiator
        ? await ozavInitiator.execute(result.settlementId)
        : {
            enabled: false as const,
          };
      const ozav = await ozavReconciler.execute(
        result.settlementId,
      );
      const nextOzavReconciliation =
        shouldContinueOzavReconciliation(ozav)
          ? await ozavReconciliationScheduler.schedule({
              settlementId: result.settlementId,
              requestId: result.requestId,
              attempt: 1,
            })
          : null;

      console.info(
        JSON.stringify({
          event: "settlement_job_processed",
          jobId: job.id,
          ...result,
          status: ozav.settlementStatus,
          ozavInitiation: initiation,
          ozav,
          nextOzavReconciliation,
        }),
      );

      return {
        ...result,
        status: ozav.settlementStatus,
        ozavInitiation: initiation,
        ozav,
        nextOzavReconciliation,
      };
    },
  );

  await boss.work<OzavReconciliationJob>(
    OZAV_RECONCILIATION_QUEUE,
    {
      pollingIntervalSeconds:
        env.JOB_POLL_INTERVAL_SECONDS,
      localConcurrency: env.JOB_CONCURRENCY,
    },
    async ([job]) => {
      if (!job) {
        throw new Error(
          "OZAV reconciliation worker received an empty batch",
        );
      }

      const result =
        await ozavReconciliationHandler.execute(job.data);

      console.info(
        JSON.stringify({
          event: "ozav_reconciliation_job_processed",
          jobId: job.id,
          ...result,
        }),
      );

      return result;
    },
  );

  await boss.work<OzavOfframpReconciliationJob>(
    OZAV_OFFRAMP_RECONCILIATION_QUEUE,
    {
      pollingIntervalSeconds:
        env.JOB_POLL_INTERVAL_SECONDS,
      localConcurrency: env.JOB_CONCURRENCY,
    },
    async ([job]) => {
      if (!job) {
        throw new Error(
          "OZAV off-ramp reconciliation worker received an empty batch",
        );
      }

      const result =
        await ozavOfframpReconciliationHandler.execute(
          job.data,
        );

      console.info(
        JSON.stringify({
          event:
            "ozav_offramp_reconciliation_job_processed",
          jobId: job.id,
          ...result,
        }),
      );

      return result;
    },
  );

  console.info(
    JSON.stringify({
      event: "worker_started",
      customerReconciliationEnabled:env.CUSTOMER_RECONCILIATION_ENABLED,
      queue: SETTLEMENT_ORCHESTRATION_QUEUE,
      concurrency: env.JOB_CONCURRENCY,
      ozavEnvironment: moneyModeFor(env),
      ozavOnrampWritesEnabled:
        env.OZAV_ONRAMP_WRITES_ENABLED,
      solanaContingencyReserveEnabled:
        env.SOLANA_CONTINGENCY_RESERVE_ENABLED,
      ozavReconciliationQueue:
        OZAV_RECONCILIATION_QUEUE,
      ozavReconciliationIntervalSeconds:
        env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
      ozavReconciliationMaxAttempts:
        env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
      ozavOfframpReconciliationQueue:
        OZAV_OFFRAMP_RECONCILIATION_QUEUE,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      ...notificationFailure(
        error,
        "startup",
        env.PERAGUS_DEPLOYMENT_ENV,
        randomUUID(),
      ),
      event: "worker_startup_failure",
    }),
  );

  await boss.stop().catch(() => undefined);
  await pool.end().catch(() => undefined);

  process.exitCode = 1;
}
