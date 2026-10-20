import {registerSandboxWithdrawalExecutionRoutes} from "./routes/sandbox-withdrawal-execution.js";
import type {SandboxWithdrawalExecutionService} from "./withdrawals/sandbox-execution.js";
import {registerWithdrawalOperatorApprovalRoutes} from "./routes/withdrawal-operator-approvals.js";
import type {WithdrawalOperatorApprovalService} from "./withdrawals/operator-approvals.js";
import {registerCustomerWithdrawalRequestRoutes} from "./routes/customer-withdrawal-requests.js";
import type {CustomerWithdrawalRequestService} from "./withdrawals/customer-withdrawal-requests.js";
import {registerCustomerSandboxPixRoutes} from "./routes/customer-sandbox-pix.js";
import type {CustomerSandboxPixService} from "./purchases/customer-sandbox-pix.js";
import { registerCustomerPurchaseIntentRoutes } from "./routes/customer-purchase-intents.js";
import type { CustomerPurchaseIntentService } from "./purchases/customer-purchase-intents.js";
import { registerCustomerQuoteRoutes } from "./routes/customer-quotes.js";
import type { CustomerQuoteService } from "./quotes/customer-quotes.js";
import { registerCustomerWalletRoutes } from "./routes/customer-wallet.js";
import type { CustomerWalletService } from "./wallets/customer-wallet.js";
import { registerCustomerOnboardingOverviewRoute } from "./routes/customer-onboarding-overview.js";
import type { CustomerOnboardingOverview } from "./onboarding/customer-onboarding-overview.js";
import { registerCustomerScreeningRoutes } from "./routes/customer-screening.js";
import type { CustomerScreeningService } from "./onboarding/customer-screening-service.js";
import { registerCustomerVerificationRoutes } from "./routes/customer-verification.js";
import type { CustomerVerificationService } from "./onboarding/customer-verification-service.js";
import { registerCustomerSubmissionRoutes } from "./routes/customer-submission.js";
import type { CustomerSubmissionService } from "./onboarding/customer-submission-service.js";
import { registerCustomerTermsRoutes } from "./routes/customer-terms.js";
import type { CustomerTermsService } from "./onboarding/customer-terms-service.js";
import { registerIndividualOnboardingRoutes } from "./routes/individual-onboarding.js";
import type { IndividualDraftService } from "./onboarding/individual-draft-service.js";
import { registerCustomerWebhookRoutes, type CustomerWebhookOptions } from "./routes/customer-webhooks.js";
import { registerOzavSandboxCustomerRoutes } from "./routes/ozav-sandbox-customer.js";
import type { OzavSandboxCustomerService } from "./application/ozav-sandbox-customer.js";
import { registerSettlementDraftRoutes } from "./routes/settlement-drafts.js";
import { registerCustomerAccess, type CustomerAccess } from "./auth/customer-access.js";
import sensible from "@fastify/sensible";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { SolanaSettlementConfirmer } from "./application/confirm-solana-settlement.js";
import type { DemoWalletFunder } from "./application/fund-devnet-demo-wallet.js";
import type { OzavOnrampReader } from "./application/get-ozav-onramp.js";
import type { SettlementAuditReader } from "./application/get-settlement-audit.js";
import type { OzavOfframpInitiator } from "./application/initiate-ozav-offramp.js";
import type { OzavOfframpReconciliationScheduler } from "./jobs/ozav-offramp-reconciliation.js";
import type { SolanaSettlementPreparer } from "./application/prepare-solana-settlement.js";
import type { SolanaRollbackDemoPreparer } from "./application/prepare-solana-rollback-demo.js";
import type { SandboxPixPaymentSimulator } from "./application/simulate-sandbox-pix-payment.js";
import {
  NoopSettlementJobPublisher,
  type SettlementJobPublisher,
} from "./jobs/settlement-orchestration.js";
import { InMemorySettlementRepository } from "./repositories/in-memory-settlement-repository.js";
import type { SettlementRepository } from "./repositories/settlement-repository.js";
import { registerOzavOfframpRoutes } from "./routes/ozav-offramp.js";
import { registerOzavOnrampRoutes } from "./routes/ozav-onramp.js";
import { registerSolanaSettlementRoutes } from "./routes/solana-settlement.js";
import { registerSettlementAuditRoutes } from "./routes/settlement-audit.js";
import { registerSettlementRoutes } from "./routes/settlements.js";

export interface BuildAppOptions {
  sandboxWithdrawalExecutionService?: SandboxWithdrawalExecutionService;
  withdrawalOperatorApprovalService?: WithdrawalOperatorApprovalService;
  customerWithdrawalRequestService?: CustomerWithdrawalRequestService;
  customerSandboxPixService?: CustomerSandboxPixService;
  customerSandboxPixSimulationEnabled?: boolean;
  customerPurchaseIntentService?: CustomerPurchaseIntentService;
  customerQuoteService?: CustomerQuoteService;
  customerWalletService?: CustomerWalletService;
  customerOnboardingOverview?: CustomerOnboardingOverview;
  customerScreeningService?: CustomerScreeningService;
  customerVerificationService?: CustomerVerificationService;
  verificationSimulationEnabled?: boolean;
  customerSubmissionService?: CustomerSubmissionService;
  customerTermsService?: CustomerTermsService;
  individualDraftService?: IndividualDraftService;
  customerWebhooks?: CustomerWebhookOptions;
  customerAccess?: CustomerAccess;
  ozavSandboxCustomerService?: OzavSandboxCustomerService;
  customerDraftRepository?: (customerId: string) => SettlementRepository;
  logger?: FastifyServerOptions["logger"];
  settlementRepository?: SettlementRepository;
  settlementJobPublisher?: SettlementJobPublisher;
  demoWalletFunder?: DemoWalletFunder | undefined;
  ozavOnrampReader?: OzavOnrampReader | undefined;
  sandboxPixPaymentSimulator?:
    | SandboxPixPaymentSimulator
    | undefined;
  settlementAuditReader?:
    | SettlementAuditReader
    | undefined;
  ozavOfframpInitiator?:
    | OzavOfframpInitiator
    | undefined;
  ozavOfframpReconciliationScheduler?:
    | OzavOfframpReconciliationScheduler
    | undefined;
  solanaSettlementPreparer?:
    | SolanaSettlementPreparer
    | undefined;
  solanaRollbackDemoPreparer?:
    | SolanaRollbackDemoPreparer
    | undefined;
  solanaSettlementConfirmer?:
    | SolanaSettlementConfirmer
    | undefined;
  now?: () => Date;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
  });

  await app.register(sensible);
  await registerCustomerWebhookRoutes(app, options.customerWebhooks);

  if (options.customerAccess) registerCustomerAccess(app, options.customerAccess);

  await registerSandboxWithdrawalExecutionRoutes(app, options.customerAccess ? options.sandboxWithdrawalExecutionService : undefined);
  await registerWithdrawalOperatorApprovalRoutes(app, options.customerAccess ? options.withdrawalOperatorApprovalService : undefined);
  await registerCustomerWithdrawalRequestRoutes(app, options.customerAccess ? options.customerWithdrawalRequestService : undefined);
  await registerCustomerSandboxPixRoutes(app, options.customerAccess ? options.customerSandboxPixService : undefined, options.customerSandboxPixSimulationEnabled ?? false);
  await registerCustomerPurchaseIntentRoutes(app, options.customerAccess ? options.customerPurchaseIntentService : undefined);
  await registerCustomerQuoteRoutes(app, options.customerAccess ? options.customerQuoteService : undefined);
  await registerCustomerWalletRoutes(app, options.customerAccess ? options.customerWalletService : undefined);
  await registerCustomerOnboardingOverviewRoute(app, options.customerAccess ? options.customerOnboardingOverview : undefined);
  await registerCustomerScreeningRoutes(app, options.customerAccess ? options.customerScreeningService : undefined);
  await registerCustomerVerificationRoutes(app, options.customerAccess ? options.customerVerificationService : undefined, options.verificationSimulationEnabled);
  await registerCustomerSubmissionRoutes(app, options.customerAccess ? options.customerSubmissionService : undefined);
  await registerCustomerTermsRoutes(app, options.customerAccess ? options.customerTermsService : undefined);
  await registerIndividualOnboardingRoutes(app, options.customerAccess ? options.individualDraftService : undefined);

  registerOzavSandboxCustomerRoutes(app, options.customerAccess ? options.ozavSandboxCustomerService : undefined);

  app.get("/health", async () => ({
    status: "ok",
    service: "peragus-backend",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  await registerSettlementDraftRoutes(app, {
    repositoryForCustomer: options.customerAccess ? options.customerDraftRepository : undefined,
    now: options.now ?? (() => new Date()),
  });

  await registerSettlementRoutes(app, {
    repository:
      options.settlementRepository
      ?? new InMemorySettlementRepository(),
    settlementJobPublisher:
      options.settlementJobPublisher
      ?? new NoopSettlementJobPublisher(),
    demoWalletFunder: options.demoWalletFunder,
    now: options.now ?? (() => new Date()),
  });

  await registerOzavOnrampRoutes(app, {
    reader: options.ozavOnrampReader,
    sandboxPaymentSimulator:
      options.sandboxPixPaymentSimulator,
    now: options.now ?? (() => new Date()),
  });

  await registerSettlementAuditRoutes(app, {
    reader: options.settlementAuditReader,
  });

  await registerOzavOfframpRoutes(app, {
    initiator: options.ozavOfframpInitiator,
    reconciliationScheduler:
      options.ozavOfframpReconciliationScheduler,
  });

  await registerSolanaSettlementRoutes(app, {
    preparer: options.solanaSettlementPreparer,
    rollbackDemoPreparer:
      options.solanaRollbackDemoPreparer,
    confirmer: options.solanaSettlementConfirmer,
  });

  return app;
}
