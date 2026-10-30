import { SandboxClosureService } from "./withdrawals/sandbox-closure.js";
import { OperatorAlertService } from "./operations/operator-alerts.js";
import { PostgresApiRateLimiter } from "./auth/api-rate-limits.js";
import { PilotInviteService } from "./invites/pilot-invites.js";
import { CustomerReconciliationStatusService } from "./jobs/customer-reconciliation.js";
import { ManualRefundService } from "./refunds/manual-refunds.js";
import {
  SandboxWithdrawalRecoveryService,
  createSandboxRecoveryReader,
} from "./withdrawals/sandbox-recovery.js";
import { OperatorWithdrawalAuditService } from "./withdrawals/operator-withdrawal-audit.js";
import { OperatorWithdrawalQueueService } from "./withdrawals/operator-withdrawal-queue.js";
import { CustomerOperationHistoryService } from "./purchases/customer-operation-history.js";
import { CustomerWithdrawalResultService } from "./withdrawals/customer-withdrawal-results.js";
import { SandboxWithdrawalExecutionService } from "./withdrawals/sandbox-execution.js";
import { PostgresSandboxExecutionRepository } from "./repositories/postgres-sandbox-withdrawal-execution.js";
import { OzavSandboxWithdrawalProvider } from "./providers/ozav-sandbox-withdrawal.js";
import { WithdrawalOperatorApprovalService } from "./withdrawals/operator-approvals.js";
import { PostgresWithdrawalOperatorApprovalRepository } from "./repositories/postgres-withdrawal-operator-approvals.js";
import { CustomerWithdrawalRequestService } from "./withdrawals/customer-withdrawal-requests.js";
import { PostgresCustomerWithdrawalRequestRepository } from "./repositories/postgres-customer-withdrawal-requests.js";
import { CustomerSandboxPixService } from "./purchases/customer-sandbox-pix.js";
import { PostgresCustomerPixRepository } from "./repositories/postgres-customer-sandbox-pix.js";
import { CustomerPurchaseIntentService } from "./purchases/customer-purchase-intents.js";
import { PostgresCustomerPurchaseIntentRepository } from "./repositories/postgres-customer-purchase-intents.js";
import { CustomerQuoteService } from "./quotes/customer-quotes.js";
import { PostgresCustomerQuoteRepository } from "./repositories/postgres-customer-quotes.js";
import { CustomerWalletService } from "./wallets/customer-wallet.js";
import { PostgresCustomerWalletRepository } from "./repositories/postgres-customer-wallet.js";
import { CustomerOnboardingOverview } from "./onboarding/customer-onboarding-overview.js";
import { PostgresOnboardingOverviewRepository } from "./repositories/postgres-onboarding-overview.js";
import { CustomerScreeningService } from "./onboarding/customer-screening-service.js";
import { PostgresCustomerScreeningRepository } from "./repositories/postgres-customer-screening.js";
import { CustomerVerificationService } from "./onboarding/customer-verification-service.js";
import { PostgresCustomerVerificationRepository } from "./repositories/postgres-customer-verification.js";
import { CustomerSubmissionService } from "./onboarding/customer-submission-service.js";
import { SubmissionVault } from "./onboarding/submission-vault.js";
import { PostgresOnboardingSubmissionRepository } from "./repositories/postgres-onboarding-submission.js";
import { CustomerTermsService } from "./onboarding/customer-terms-service.js";
import { TermsVault } from "./onboarding/terms-vault.js";
import { PostgresCustomerTermsRepository } from "./repositories/postgres-customer-terms.js";
import { DraftCipher } from "./onboarding/draft-cipher.js";
import { IndividualDraftService } from "./onboarding/individual-draft-service.js";
import { PostgresIndividualDraftRepository } from "./repositories/postgres-individual-draft.js";
import { PostgresCustomerWebhookProcessor } from "./repositories/postgres-customer-webhook.js";
import { OzavSandboxCustomerService } from "./application/ozav-sandbox-customer.js";
import { PostgresSandboxCustomerLinkRepository } from "./repositories/postgres-sandbox-customer-link.js";
import { assertSmokeTestSafety } from "./jobs/worker-smoke-test.js";
import { createSupabaseAuthenticator } from "./auth/supabase-authenticator.js";
import { PostgresCustomerRepository } from "./repositories/postgres-customer-repository.js";
import { Connection, PublicKey } from "@solana/web3.js";
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
  throw new Error(
    "DATABASE_URL, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required for the authenticated API",
  );
}
if (
  env.OZAV_ONRAMP_WRITES_ENABLED ||
  env.OZAV_OFFRAMP_WRITES_ENABLED ||
  env.SOLANA_COSIGNING_ENABLED ||
  env.SOLANA_CONTINGENCY_RESERVE_ENABLED ||
  env.PERAGUS_SANDBOX_DEMO_ENABLED
) {
  throw new Error(
    "Authenticated customer onboarding requires financial and demo flags disabled until per-customer routing is implemented",
  );
}
if (
  env.SETTLEMENT_DRAFTS_ENABLED ||
  env.OZAV_SANDBOX_CUSTOMERS_ENABLED ||
  env.CUSTOMER_WEBHOOKS_ENABLED ||
  env.CUSTOMER_ONBOARDING_ENABLED ||
  env.CUSTOMER_TERMS_ENABLED ||
  env.CUSTOMER_SUBMISSION_ENABLED ||
  env.CUSTOMER_VERIFICATIONS_ENABLED ||
  env.CUSTOMER_SCREENINGS_ENABLED ||
  env.CUSTOMER_ONBOARDING_STATUS_ENABLED ||
  env.CUSTOMER_WALLET_LINKING_ENABLED ||
  env.CUSTOMER_QUOTES_ENABLED ||
  env.CUSTOMER_PURCHASE_INTENTS_ENABLED ||
  env.CUSTOMER_SANDBOX_PIX_ENABLED ||
  env.CUSTOMER_WITHDRAWAL_REQUESTS_ENABLED ||
  env.WITHDRAWAL_OPERATOR_APPROVALS_ENABLED ||
  env.SANDBOX_WITHDRAWAL_EXECUTION_ENABLED ||
  env.SANDBOX_WITHDRAWAL_RECOVERY_ENABLED ||
  env.MANUAL_REFUNDS_ENABLED ||
  env.PILOT_INVITES_ENABLED ||
  env.SANDBOX_WITHDRAWAL_CLOSURE_ENABLED
) {
  assertSmokeTestSafety(env);
  if (env.SUPABASE_URL !== "https://lybdkqkbwlfwvmmvstzi.supabase.co") {
    throw new Error(
      "Settlement drafts require the pinned staging Auth project",
    );
  }
}
if (
  (env.OZAV_SANDBOX_CUSTOMERS_ENABLED ||
    env.CUSTOMER_WEBHOOKS_ENABLED ||
    env.CUSTOMER_TERMS_ENABLED ||
    env.CUSTOMER_SUBMISSION_ENABLED ||
    env.CUSTOMER_VERIFICATIONS_ENABLED ||
    env.CUSTOMER_SCREENINGS_ENABLED ||
    env.CUSTOMER_QUOTES_ENABLED ||
    env.CUSTOMER_SANDBOX_PIX_ENABLED ||
    env.SANDBOX_WITHDRAWAL_EXECUTION_ENABLED ||
    env.SANDBOX_WITHDRAWAL_RECOVERY_ENABLED ||
    env.SANDBOX_WITHDRAWAL_CLOSURE_ENABLED) &&
  !env.OZAV_API_KEY
) {
  throw new Error(
    "OZAV_API_KEY sandbox key is required for customer fixture onboarding",
  );
}
if (env.CUSTOMER_WEBHOOKS_ENABLED && !env.CUSTOMER_WEBHOOK_SECRET) {
  throw new Error(
    "CUSTOMER_WEBHOOK_SECRET is required for customer update notifications",
  );
}
if (
  env.CUSTOMER_VERIFICATION_SIMULATION_ENABLED &&
  !env.CUSTOMER_VERIFICATIONS_ENABLED
) {
  throw new Error(
    "Verification simulation requires the sandbox verification feature",
  );
}
if (
  env.CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED &&
  !env.CUSTOMER_SANDBOX_PIX_ENABLED
) {
  throw new Error(
    "Customer Pix simulation requires the customer sandbox Pix feature",
  );
}
if (
  (env.WITHDRAWAL_OPERATOR_APPROVALS_ENABLED ||
    env.SANDBOX_WITHDRAWAL_EXECUTION_ENABLED ||
    env.SANDBOX_WITHDRAWAL_RECOVERY_ENABLED ||
    env.MANUAL_REFUNDS_ENABLED ||
    env.PILOT_INVITES_ENABLED ||
    env.SANDBOX_WITHDRAWAL_CLOSURE_ENABLED) &&
  env.WITHDRAWAL_OPERATOR_USER_IDS.length === 0
) {
  throw new Error(
    "Withdrawal approvals require an explicit operator allowlist",
  );
}
const individualDraftCipher =
  env.CUSTOMER_ONBOARDING_ENABLED ||
  env.CUSTOMER_TERMS_ENABLED ||
  env.CUSTOMER_SUBMISSION_ENABLED
    ? new DraftCipher(
        env.CUSTOMER_DATA_ENCRYPTION_KEY ?? "",
        env.CUSTOMER_DATA_ENCRYPTION_KEY_ID,
      )
    : undefined;
const authenticate = createSupabaseAuthenticator(
  env.SUPABASE_URL,
  env.SUPABASE_PUBLISHABLE_KEY,
);

let pool: Pool | undefined;
let boss: PgBoss | undefined;
let settlementRepository: SettlementRepository;
let demoWalletFunder: DemoWalletFunder | undefined;
let ozavOnrampReader: OzavOnrampReader | undefined;
let sandboxPixPaymentSimulator: SandboxPixPaymentSimulator | undefined;
let settlementAuditReader: SettlementAuditReader | undefined;
let ozavOfframpInitiator: OzavOfframpInitiator | undefined;
let ozavOfframpReconciliationScheduler:
  OzavOfframpReconciliationScheduler | undefined;
let solanaSettlementPreparer: SolanaSettlementPreparer | undefined;
let solanaRollbackDemoPreparer: SolanaRollbackDemoPreparer | undefined;
let solanaSettlementConfirmer: SolanaSettlementConfirmer | undefined;
let settlementJobPublisher: SettlementJobPublisher =
  new NoopSettlementJobPublisher();

if (env.DATABASE_URL) {
  const databasePool = createDatabasePool(env.DATABASE_URL, env.DATABASE_SSL);

  const jobQueue = createJobQueue(env.DATABASE_URL, env.DATABASE_SSL);

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
  const ozavReconciliationScheduler = new PgBossOzavReconciliationScheduler(
    jobQueue,
    env.OZAV_RECONCILIATION_INTERVAL_SECONDS,
    env.OZAV_RECONCILIATION_MAX_ATTEMPTS,
  );

  settlementRepository = new PostgresSettlementRepository(databasePool);

  const onrampIntents = new PostgresOzavOnrampIntentRepository(databasePool);
  const onramps = new PostgresOzavOnrampRepository(databasePool);
  const offramps = new PostgresOzavOfframpIntentRepository(databasePool);
  const contingencyReserves = new PostgresSolanaContingencyReserveRepository(
    databasePool,
  );
  const solanaSettlements = new PostgresSolanaSettlementConfirmationRepository(
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
    sandboxPixPaymentSimulator = new SimulateSandboxPixPaymentService({
      settlements: settlementRepository,
      onramps,
      client: new OzavClient({
        apiKey: env.OZAV_API_KEY!,
        timeoutMs: 10_000,
        attempts: 1,
      }),
      reconciliationScheduler: ozavReconciliationScheduler,
    });
  }

  if (env.OZAV_OFFRAMP_WRITES_ENABLED) {
    if (env.NODE_ENV === "production" && !env.PERAGUS_SANDBOX_DEMO_ENABLED) {
      throw new Error(
        "OZAV sandbox off-ramp writes cannot be enabled in production",
      );
    }

    const ozavClient = new OzavClient({
      apiKey: env.OZAV_API_KEY!,
    });

    ozavOfframpInitiator = new InitiateOzavOfframpService({
      client: ozavClient,
      intents: offramps,
      onramps,
      settlements: settlementRepository,
      transitioner: new TransitionSettlementService(settlementRepository),
      customerId: env.OZAV_CUSTOMER_ID!,
      walletId: env.OZAV_WALLET_ID!,
      spreadBps: env.OZAV_SPREAD_BPS,
    });
  }

  if (env.SOLANA_COSIGNING_ENABLED) {
    if (env.NODE_ENV === "production" && !env.PERAGUS_SANDBOX_DEMO_ENABLED) {
      throw new Error(
        "Local Solana keypair signers cannot be enabled in production; configure an HSM/KMS signer adapter",
      );
    }

    if (!env.SOLANA_SOURCE_MINT || !env.SOLANA_DESTINATION_MINT) {
      throw new Error("Solana cosigning configuration is incomplete");
    }

    const solanaConnection = new Connection(env.SOLANA_RPC_URL, "confirmed");
    const solanaProgramId = new PublicKey(env.SOLANA_PROGRAM_ID);
    const sourceMint = new PublicKey(env.SOLANA_SOURCE_MINT);
    const destinationMint = new PublicKey(env.SOLANA_DESTINATION_MINT);
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
      const fundingAuthority = loadConfiguredSolanaAuthority({
        filePath: env.SOLANA_FEE_PAYER_KEYPAIR_PATH,
        keypairBase64: env.SOLANA_FEE_PAYER_KEYPAIR_BASE64,
        label: "SOLANA_FEE_PAYER",
      });
      demoWalletFunder = new FundDevnetDemoWalletService({
        connection: solanaConnection,
        sourceMint,
        fundingAuthority,
      });

      solanaRollbackDemoPreparer = new PrepareSolanaRollbackDemoService({
        settlements: settlementRepository,
        connection: solanaConnection,
        programId: solanaProgramId,
        sourceMint,
        destinationMint,
        attestationAuthority,
        liquidityAuthority,
      });
    }

    solanaSettlementPreparer = new PrepareSolanaSettlementService({
      settlements: settlementRepository,
      preparations: new PostgresSolanaSettlementPreparationRepository(
        databasePool,
      ),
      connection: solanaConnection,
      programId: solanaProgramId,
      sourceMint,
      destinationMint,
      attestationAuthority,
      liquidityAuthority,
    });

    solanaSettlementConfirmer = new ConfirmSolanaSettlementService({
      settlements: settlementRepository,
      confirmations: solanaSettlements,
      connection: solanaConnection,
      programId: solanaProgramId,
      sourceMint,
      destinationMint,
      attestationAuthority: attestationAuthority.publicKey,
      liquidityAuthority: liquidityAuthority.publicKey,
    });
  }

  settlementJobPublisher = new PgBossSettlementJobPublisher(jobQueue);
} else {
  if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required when NODE_ENV=production");
  }

  settlementRepository = new InMemorySettlementRepository();
}

const draftService = individualDraftCipher
  ? new IndividualDraftService(
      new PostgresIndividualDraftRepository(pool!),
      individualDraftCipher,
    )
  : undefined;
const customerTermsService =
  env.CUSTOMER_TERMS_ENABLED || env.CUSTOMER_SUBMISSION_ENABLED
    ? new CustomerTermsService(
        new PostgresCustomerTermsRepository(pool!),
        new TermsVault(
          env.CUSTOMER_DATA_ENCRYPTION_KEY ?? "",
          env.CUSTOMER_DATA_ENCRYPTION_KEY_ID,
        ),
        new OzavClient({
          apiKey: env.OZAV_API_KEY!,
          attempts: 1,
          timeoutMs: 5000,
        }),
        draftService!,
      )
    : undefined;
const app = await buildApp({
  ...(pool
    ? {
        sandboxClosureService: new SandboxClosureService(
          pool,
          new PostgresSandboxExecutionRepository(pool),
          new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
          env.SANDBOX_WITHDRAWAL_CLOSURE_ENABLED,
          env.SANDBOX_WITHDRAWAL_CLOSURE_ENABLED
            ? createSandboxRecoveryReader(env.OZAV_API_KEY!)
            : undefined,
        ),
      }
    : {}),
  ...(pool
    ? {
        operatorAlertService: new OperatorAlertService(
          pool,
          new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
        ),
      }
    : {}),
  ...(env.API_RATE_LIMITS_ENABLED
    ? { apiRateLimiter: new PostgresApiRateLimiter(pool!) }
    : {}),
  ...(pool
    ? {
        pilotInviteService: new PilotInviteService(
          pool,
          new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
          env.PILOT_INVITES_ENABLED,
          env.PILOT_INVITE_EMAIL_HASH_KEY,
        ),
      }
    : {}),
  ...(pool
    ? {
        customerReconciliationStatusService:
          new CustomerReconciliationStatusService(
            pool,
            new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
          ),
      }
    : {}),
  ...(pool
    ? {
        manualRefundService: new ManualRefundService(
          pool,
          new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
          env.MANUAL_REFUNDS_ENABLED,
        ),
      }
    : {}),
  ...(env.SANDBOX_WITHDRAWAL_RECOVERY_ENABLED
    ? {
        sandboxWithdrawalRecoveryService: new SandboxWithdrawalRecoveryService(
          new PostgresSandboxExecutionRepository(pool!),
          createSandboxRecoveryReader(env.OZAV_API_KEY!),
          new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
        ),
      }
    : {}),
  ...(pool
    ? {
        operatorWithdrawalAuditService: new OperatorWithdrawalAuditService(
          pool,
          new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
        ),
      }
    : {}),
  ...(pool
    ? {
        operatorWithdrawalQueueService: new OperatorWithdrawalQueueService(
          pool,
          new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
        ),
      }
    : {}),
  ...(pool
    ? {
        customerOperationHistoryService: new CustomerOperationHistoryService(
          pool,
        ),
      }
    : {}),
  ...(pool
    ? {
        customerWithdrawalResultService: new CustomerWithdrawalResultService(
          pool,
        ),
      }
    : {}),
  ...(env.SANDBOX_WITHDRAWAL_EXECUTION_ENABLED
    ? {
        sandboxWithdrawalExecutionService:
          new SandboxWithdrawalExecutionService(
            new PostgresSandboxExecutionRepository(pool!),
            new OzavSandboxWithdrawalProvider(env.OZAV_API_KEY!),
            new WithdrawalOperatorApprovalService(
              new PostgresWithdrawalOperatorApprovalRepository(pool!),
              new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
            ),
          ),
      }
    : {}),
  ...(env.WITHDRAWAL_OPERATOR_APPROVALS_ENABLED
    ? {
        withdrawalOperatorApprovalService:
          new WithdrawalOperatorApprovalService(
            new PostgresWithdrawalOperatorApprovalRepository(pool!),
            new Set(env.WITHDRAWAL_OPERATOR_USER_IDS),
          ),
      }
    : {}),
  ...(env.CUSTOMER_WITHDRAWAL_REQUESTS_ENABLED
    ? {
        customerWithdrawalRequestService: new CustomerWithdrawalRequestService(
          new PostgresCustomerWithdrawalRequestRepository(pool!),
        ),
      }
    : {}),
  customerSandboxPixSimulationEnabled:
    env.CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED,
  ...(env.CUSTOMER_SANDBOX_PIX_ENABLED
    ? {
        customerSandboxPixService: new CustomerSandboxPixService(
          new PostgresCustomerPixRepository(pool!),
          new OzavClient({
            apiKey: env.OZAV_API_KEY!,
            attempts: 1,
            timeoutMs: 5000,
          }),
        ),
      }
    : {}),
  ...(env.CUSTOMER_PURCHASE_INTENTS_ENABLED
    ? {
        customerPurchaseIntentService: new CustomerPurchaseIntentService(
          new PostgresCustomerPurchaseIntentRepository(pool!),
        ),
      }
    : {}),
  ...(env.CUSTOMER_QUOTES_ENABLED
    ? {
        customerQuoteService: new CustomerQuoteService(
          new PostgresCustomerQuoteRepository(pool!),
          new PostgresOnboardingSubmissionRepository(pool!),
          new OzavClient({
            apiKey: env.OZAV_API_KEY!,
            attempts: 1,
            timeoutMs: 5000,
          }),
        ),
      }
    : {}),
  ...(env.CUSTOMER_WALLET_LINKING_ENABLED
    ? {
        customerWalletService: new CustomerWalletService(
          new PostgresCustomerWalletRepository(pool!),
        ),
      }
    : {}),
  ...(env.CUSTOMER_ONBOARDING_STATUS_ENABLED
    ? {
        customerOnboardingOverview: new CustomerOnboardingOverview(
          new PostgresOnboardingOverviewRepository(pool!),
          {
            draft: env.CUSTOMER_ONBOARDING_ENABLED,
            terms: env.CUSTOMER_TERMS_ENABLED,
            submission: env.CUSTOMER_SUBMISSION_ENABLED,
            verification: env.CUSTOMER_VERIFICATIONS_ENABLED,
            screening: env.CUSTOMER_SCREENINGS_ENABLED,
            wallet: env.CUSTOMER_WALLET_LINKING_ENABLED,
          },
        ),
      }
    : {}),
  ...(env.CUSTOMER_SCREENINGS_ENABLED
    ? {
        customerScreeningService: new CustomerScreeningService(
          new PostgresCustomerScreeningRepository(pool!),
          new PostgresOnboardingSubmissionRepository(pool!),
          new OzavClient({
            apiKey: env.OZAV_API_KEY!,
            attempts: 1,
            timeoutMs: 5000,
          }),
        ),
      }
    : {}),
  ...(env.CUSTOMER_VERIFICATIONS_ENABLED
    ? {
        customerVerificationService: new CustomerVerificationService(
          new PostgresCustomerVerificationRepository(pool!),
          new PostgresOnboardingSubmissionRepository(pool!),
          new OzavClient({
            apiKey: env.OZAV_API_KEY!,
            attempts: 1,
            timeoutMs: 5000,
          }),
        ),
        verificationSimulationEnabled:
          env.CUSTOMER_VERIFICATION_SIMULATION_ENABLED,
      }
    : {}),
  ...(env.CUSTOMER_SUBMISSION_ENABLED
    ? {
        customerSubmissionService: new CustomerSubmissionService(
          new PostgresOnboardingSubmissionRepository(pool!),
          new SubmissionVault(
            env.CUSTOMER_DATA_ENCRYPTION_KEY ?? "",
            env.CUSTOMER_DATA_ENCRYPTION_KEY_ID,
          ),
          draftService!,
          customerTermsService!,
          new OzavClient({
            apiKey: env.OZAV_API_KEY!,
            attempts: 1,
            timeoutMs: 5000,
          }),
        ),
      }
    : {}),
  ...(env.CUSTOMER_TERMS_ENABLED
    ? { customerTermsService: customerTermsService! }
    : {}),
  ...(env.CUSTOMER_ONBOARDING_ENABLED
    ? { individualDraftService: draftService! }
    : {}),
  ...(env.CUSTOMER_WEBHOOKS_ENABLED
    ? {
        customerWebhooks: {
          secret: env.CUSTOMER_WEBHOOK_SECRET!,
          processor: new PostgresCustomerWebhookProcessor(
            pool!,
            new OzavClient({
              apiKey: env.OZAV_API_KEY!,
              attempts: 1,
              timeoutMs: 3000,
            }),
          ),
        },
      }
    : {}),
  customerAccess: {
    authenticate,
    customers: new PostgresCustomerRepository(pool!),
  },
  ...(env.OZAV_SANDBOX_CUSTOMERS_ENABLED
    ? {
        ozavSandboxCustomerService: new OzavSandboxCustomerService(
          new PostgresSandboxCustomerLinkRepository(pool!),
          new OzavClient({ apiKey: env.OZAV_API_KEY!, attempts: 1 }),
        ),
      }
    : {}),
  ...(env.SETTLEMENT_DRAFTS_ENABLED
    ? {
        customerDraftRepository: (customerId: string) =>
          PostgresSettlementRepository.forCustomerDrafts(pool!, customerId),
      }
    : {}),
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      'req.headers["x-ozav-signature"]',
    ],
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

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  app.log.info({ signal }, "Shutting down Peragus backend");

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
  app.log.info({
    event: "sandbox_withdrawal_closure_configured",
    enabled: env.SANDBOX_WITHDRAWAL_CLOSURE_ENABLED,
  });
  app.log.info({
    event: "api_rate_limits_configured",
    enabled: env.API_RATE_LIMITS_ENABLED,
    readsPerMinute: 60,
    writesPerMinute: 10,
  });
  app.log.info({
    event: "pilot_invites_configured",
    enabled: env.PILOT_INVITES_ENABLED,
    newProfilesRequireInvite: Boolean(pool),
  });
  app.log.info({
    event: "manual_refunds_configured",
    enabled: env.MANUAL_REFUNDS_ENABLED,
    recordOnly: true,
  });
  app.log.info({
    event: "sandbox_withdrawal_recovery_configured",
    enabled: env.SANDBOX_WITHDRAWAL_RECOVERY_ENABLED,
  });
  app.log.info({
    event: "sandbox_withdrawal_execution_configured",
    enabled: env.SANDBOX_WITHDRAWAL_EXECUTION_ENABLED,
  });
  app.log.info({
    event: "customer_withdrawal_requests_configured",
    enabled: env.CUSTOMER_WITHDRAWAL_REQUESTS_ENABLED,
  });
  app.log.info({
    event: "customer_sandbox_pix_simulation_configured",
    enabled: env.CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED,
  });
  app.log.info({
    event: "customer_sandbox_pix_configured",
    enabled: env.CUSTOMER_SANDBOX_PIX_ENABLED,
  });
  app.log.info({
    event: "customer_purchase_intents_configured",
    enabled: env.CUSTOMER_PURCHASE_INTENTS_ENABLED,
  });
  app.log.info({
    event: "customer_quotes_configured",
    enabled: env.CUSTOMER_QUOTES_ENABLED,
  });
  app.log.info({
    event: "customer_wallet_linking_configured",
    enabled: env.CUSTOMER_WALLET_LINKING_ENABLED,
  });
  app.log.info({
    event: "customer_onboarding_status_configured",
    enabled: env.CUSTOMER_ONBOARDING_STATUS_ENABLED,
  });
  app.log.info({
    event: "customer_screening_configured",
    enabled: env.CUSTOMER_SCREENINGS_ENABLED,
  });
  app.log.info({
    event: "customer_verification_configured",
    enabled: env.CUSTOMER_VERIFICATIONS_ENABLED,
    simulation_enabled: env.CUSTOMER_VERIFICATION_SIMULATION_ENABLED,
  });
  app.log.info({
    event: "customer_submission_configured",
    enabled: env.CUSTOMER_SUBMISSION_ENABLED,
  });
  app.log.info({
    event: "customer_terms_configured",
    enabled: env.CUSTOMER_TERMS_ENABLED,
  });
  app.log.info({
    event: "customer_onboarding_configured",
    enabled: env.CUSTOMER_ONBOARDING_ENABLED,
  });
  app.log.info({
    event: "customer_webhook_receiver_configured",
    enabled: env.CUSTOMER_WEBHOOKS_ENABLED,
  });
  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
