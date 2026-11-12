import { registerInviteDeliveryRoute, type InviteDeliveryOptions } from "./routes/invite-email-delivery.js";
import { registerCustomerDocumentRoutes } from "./routes/customer-documents.js";
import type { CustomerDocumentService } from "./onboarding/customer-documents.js";
import { registerPilotInviteRoutes } from "./routes/pilot-invites.js";
import type { PilotInviteService } from "./invites/pilot-invites.js";
import { registerCustomerReconciliationStatusRoutes } from "./routes/customer-reconciliation-status.js";
import type { CustomerReconciliationStatusService } from "./jobs/customer-reconciliation.js";
import { registerManualRefundRoutes } from "./routes/manual-refunds.js";
import type { ManualRefundService } from "./refunds/manual-refunds.js";
import type { SandboxWithdrawalRecoveryService } from "./withdrawals/sandbox-recovery.js";
import { registerOperatorWithdrawalAuditRoutes } from "./routes/operator-withdrawal-audit.js";
import type { OperatorWithdrawalAuditService } from "./withdrawals/operator-withdrawal-audit.js";
import { registerOperatorWithdrawalQueueRoutes } from "./routes/operator-withdrawal-queue.js";
import type { OperatorWithdrawalQueueService } from "./withdrawals/operator-withdrawal-queue.js";
import { registerCustomerOperationHistoryRoutes } from "./routes/customer-operation-history.js";
import type { CustomerOperationHistoryService } from "./purchases/customer-operation-history.js";
import { registerCustomerWithdrawalResultRoutes } from "./routes/customer-withdrawal-results.js";
import type { CustomerWithdrawalResultService } from "./withdrawals/customer-withdrawal-results.js";
import { registerSandboxWithdrawalExecutionRoutes } from "./routes/sandbox-withdrawal-execution.js";
import type { SandboxWithdrawalExecutionService } from "./withdrawals/sandbox-execution.js";
import { registerWithdrawalOperatorApprovalRoutes } from "./routes/withdrawal-operator-approvals.js";
import type { WithdrawalOperatorApprovalService } from "./withdrawals/operator-approvals.js";
import { registerCustomerWithdrawalRequestRoutes } from "./routes/customer-withdrawal-requests.js";
import type { CustomerWithdrawalRequestService } from "./withdrawals/customer-withdrawal-requests.js";
import { registerCustomerSandboxPixRoutes } from "./routes/customer-sandbox-pix.js";
import type { CustomerPixService } from "./purchases/customer-sandbox-pix.js";
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
import {
  registerCustomerWebhookRoutes,
  type CustomerWebhookOptions,
} from "./routes/customer-webhooks.js";
import { registerOzavSandboxCustomerRoutes } from "./routes/ozav-sandbox-customer.js";
import type { OzavSandboxCustomerService } from "./application/ozav-sandbox-customer.js";
import { registerSettlementDraftRoutes } from "./routes/settlement-drafts.js";
import {
  registerCustomerAccess,
  type CustomerAccess,
} from "./auth/customer-access.js";
import type { ApiRateLimiter } from "./auth/api-rate-limits.js";
import type { OperatorAlertService } from "./operations/operator-alerts.js";
import { registerOperatorAlertRoutes } from "./routes/operator-alerts.js";
import type { SandboxClosureService } from "./withdrawals/sandbox-closure.js";
import { registerSandboxClosureRoutes } from "./routes/sandbox-withdrawal-closure.js";
import {moneyNetworkFor,type MoneyMode} from "./config/money-environment.js";
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
  /** Configured money mode; sandbox-only simulation routes exist only in "test". Defaults to "test". */
  moneyMode?: MoneyMode;
  inviteDelivery?: InviteDeliveryOptions;
  manualRefundService?: ManualRefundService;
  sandboxWithdrawalRecoveryService?: SandboxWithdrawalRecoveryService;
  operatorWithdrawalAuditService?: OperatorWithdrawalAuditService;
  operatorWithdrawalQueueService?: OperatorWithdrawalQueueService;
  customerOperationHistoryService?: CustomerOperationHistoryService;
  customerReconciliationStatusService?: CustomerReconciliationStatusService;
  customerWithdrawalResultService?: CustomerWithdrawalResultService;
  sandboxWithdrawalExecutionService?: SandboxWithdrawalExecutionService;
  withdrawalOperatorApprovalService?: WithdrawalOperatorApprovalService;
  /** WITHDRAWAL_OPERATOR_USER_IDS, for GET /v1/admin/operator-status only. */
  operatorUserIds?: ReadonlySet<string>;
  customerWithdrawalRequestService?: CustomerWithdrawalRequestService;
  customerSandboxPixService?: CustomerPixService;
  customerSandboxPixSimulationEnabled?: boolean;
  customerPurchaseIntentService?: CustomerPurchaseIntentService;
  customerQuoteService?: CustomerQuoteService;
  customerWalletService?: CustomerWalletService;
  customerOnboardingOverview?: CustomerOnboardingOverview;
  customerScreeningService?: CustomerScreeningService;
  customerDocumentService?: CustomerDocumentService;
  customerVerificationService?: CustomerVerificationService;
  verificationSimulationEnabled?: boolean;
  customerSubmissionService?: CustomerSubmissionService;
  customerTermsService?: CustomerTermsService;
  individualDraftService?: IndividualDraftService;
  customerWebhooks?: CustomerWebhookOptions;
  customerAccess?: CustomerAccess;
  /** Reverse-proxy hops to trust for request.ip (TRUST_PROXY_HOPS); 0 trusts none. */
  trustProxyHops?: number;
  apiRateLimiter?: ApiRateLimiter;
  operatorAlertService?: OperatorAlertService;
  sandboxClosureService?: SandboxClosureService;
  pilotInviteService?: PilotInviteService;
  ozavSandboxCustomerService?: OzavSandboxCustomerService;
  customerDraftRepository?: (customerId: string) => SettlementRepository;
  logger?: FastifyServerOptions["logger"];
  settlementRepository?: SettlementRepository;
  settlementJobPublisher?: SettlementJobPublisher;
  demoWalletFunder?: DemoWalletFunder | undefined;
  ozavOnrampReader?: OzavOnrampReader | undefined;
  sandboxPixPaymentSimulator?: SandboxPixPaymentSimulator | undefined;
  settlementAuditReader?: SettlementAuditReader | undefined;
  ozavOfframpInitiator?: OzavOfframpInitiator | undefined;
  ozavOfframpReconciliationScheduler?:
    OzavOfframpReconciliationScheduler | undefined;
  solanaSettlementPreparer?: SolanaSettlementPreparer | undefined;
  solanaRollbackDemoPreparer?: SolanaRollbackDemoPreparer | undefined;
  solanaSettlementConfirmer?: SolanaSettlementConfirmer | undefined;
  now?: () => Date;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const mode: MoneyMode = options.moneyMode ?? "test";
  if (mode !== "test" && mode !== "live")
    throw Object.assign(new Error("MONEY_ENVIRONMENT_INVALID"), { code: "MONEY_ENVIRONMENT_INVALID" });
  const sandboxOnly = mode === "test";
  const serverOptions: FastifyServerOptions = {
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    // Only the configured number of proxy hops is trusted for request.ip; with 0 every
    // X-Forwarded-For value is ignored.
    trustProxy: (_address: string, hop: number) => hop < (options.trustProxyHops ?? 0),
  };
  const app = Fastify(serverOptions);


  await app.register(sensible);
  await registerInviteDeliveryRoute(app, options.inviteDelivery);
  await registerCustomerWebhookRoutes(app, options.customerWebhooks);

  if (options.apiRateLimiter && !options.customerAccess)
    throw new Error("API rate limits require verified authentication");
  if (options.customerAccess)
    registerCustomerAccess(
      app,
      options.customerAccess,
      Boolean(options.pilotInviteService),
      options.apiRateLimiter,
    );

  if (options.customerAccess) {
    const access = options.customerAccess;
    const operators = options.operatorUserIds ?? new Set<string>();
    // Any authenticated user (AAL1 is enough: it runs before MFA enrollment) learns only
    // whether it is an operator, so the frontend offers MFA enrollment to operators only.
    app.get("/v1/admin/operator-status", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const user = request.authenticatedUser;
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
      if (Object.keys(request.query as object).length)
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      // A customer account is never an operator (account separation).
      const operator =
        operators.has(user.id.toLowerCase()) &&
        !(await access.customers.findByOwner(user.id));
      return { data: { operator, mfa_enrolled_required: true as const } };
    });
  }

  app.get("/v1/me/purchase-capabilities", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.authenticatedUser || !request.authenticatedCustomer)
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    return {
      data: {
        environment: mode,
        operations_enabled: false,
        real_purchase: mode === "live",
        required_costs_complete: false,
        quote: Boolean(options.customerQuoteService),
        record: Boolean(options.customerPurchaseIntentService),
        pix: Boolean(options.customerSandboxPixService),
        network: moneyNetworkFor(mode),
      },
    };
  });
  await registerSandboxClosureRoutes(
    app,
    options.customerAccess ? options.sandboxClosureService : undefined,
  );
  await registerOperatorAlertRoutes(
    app,
    options.customerAccess ? options.operatorAlertService : undefined,
  );
  await registerPilotInviteRoutes(
    app,
    options.customerAccess ? options.pilotInviteService : undefined,
  );
  await registerSandboxWithdrawalExecutionRoutes(
    app,
    options.customerAccess
      ? options.sandboxWithdrawalExecutionService
      : undefined,
    options.customerAccess
      ? options.sandboxWithdrawalRecoveryService
      : undefined,
  );
  await registerWithdrawalOperatorApprovalRoutes(
    app,
    options.customerAccess
      ? options.withdrawalOperatorApprovalService
      : undefined,
  );
  await registerManualRefundRoutes(
    app,
    options.customerAccess ? options.manualRefundService : undefined,
  );
  await registerOperatorWithdrawalAuditRoutes(
    app,
    options.customerAccess ? options.operatorWithdrawalAuditService : undefined,
  );
  await registerOperatorWithdrawalQueueRoutes(
    app,
    options.customerAccess ? options.operatorWithdrawalQueueService : undefined,
  );
  await registerCustomerReconciliationStatusRoutes(
    app,
    options.customerAccess
      ? options.customerReconciliationStatusService
      : undefined,
  );
  await registerCustomerOperationHistoryRoutes(
    app,
    options.customerAccess
      ? options.customerOperationHistoryService
      : undefined,
  );
  await registerCustomerWithdrawalResultRoutes(
    app,
    options.customerAccess
      ? options.customerWithdrawalResultService
      : undefined,
  );
  await registerCustomerWithdrawalRequestRoutes(
    app,
    options.customerAccess
      ? options.customerWithdrawalRequestService
      : undefined,
  );
  await registerCustomerSandboxPixRoutes(
    app,
    options.customerAccess ? options.customerSandboxPixService : undefined,
    sandboxOnly && (options.customerSandboxPixSimulationEnabled ?? false),
    sandboxOnly,
  );
  await registerCustomerPurchaseIntentRoutes(
    app,
    options.customerAccess ? options.customerPurchaseIntentService : undefined,
  );
  await registerCustomerQuoteRoutes(
    app,
    options.customerAccess ? options.customerQuoteService : undefined,
  );
  await registerCustomerWalletRoutes(
    app,
    options.customerAccess ? options.customerWalletService : undefined,
  );
  await registerCustomerOnboardingOverviewRoute(
    app,
    options.customerAccess ? options.customerOnboardingOverview : undefined,
  );
  await registerCustomerScreeningRoutes(
    app,
    options.customerAccess ? options.customerScreeningService : undefined,
  );
  await registerCustomerDocumentRoutes(app, options.customerAccess, options.customerDocumentService);
  await registerCustomerVerificationRoutes(
    app,
    options.customerAccess ? options.customerVerificationService : undefined,
    sandboxOnly && (options.verificationSimulationEnabled ?? false),
    sandboxOnly,
  );
  await registerCustomerSubmissionRoutes(
    app,
    options.customerAccess ? options.customerSubmissionService : undefined,
  );
  await registerCustomerTermsRoutes(
    app,
    options.customerAccess ? options.customerTermsService : undefined,
  );
  await registerIndividualOnboardingRoutes(
    app,
    options.customerAccess ? options.individualDraftService : undefined,
    mode,
  );

  // Synthetic OZAV customers are a sandbox fixture; the routes do not exist outside test mode.
  if (sandboxOnly)
    registerOzavSandboxCustomerRoutes(
      app,
      options.customerAccess ? options.ozavSandboxCustomerService : undefined,
    );

  app.get("/health", async () => ({
    status: "ok",
    service: "peragus-backend",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  await registerSettlementDraftRoutes(app, {
    repositoryForCustomer: options.customerAccess
      ? options.customerDraftRepository
      : undefined,
    now: options.now ?? (() => new Date()),
  });

  await registerSettlementRoutes(app, {
    repository:
      options.settlementRepository ?? new InMemorySettlementRepository(),
    settlementJobPublisher:
      options.settlementJobPublisher ?? new NoopSettlementJobPublisher(),
    demoWalletFunder: options.demoWalletFunder,
    now: options.now ?? (() => new Date()),
  });

  await registerOzavOnrampRoutes(app, {
    reader: options.ozavOnrampReader,
    sandboxPaymentSimulator: sandboxOnly
      ? options.sandboxPixPaymentSimulator
      : undefined,
    now: options.now ?? (() => new Date()),
  });

  await registerSettlementAuditRoutes(app, {
    reader: options.settlementAuditReader,
  });

  await registerOzavOfframpRoutes(app, {
    initiator: options.ozavOfframpInitiator,
    reconciliationScheduler: options.ozavOfframpReconciliationScheduler,
  });

  await registerSolanaSettlementRoutes(app, {
    preparer: options.solanaSettlementPreparer,
    rollbackDemoPreparer: options.solanaRollbackDemoPreparer,
    confirmer: options.solanaSettlementConfirmer,
  });

  return app;
}
