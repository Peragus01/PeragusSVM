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
  customerAccess?: CustomerAccess;
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

  if (options.customerAccess) registerCustomerAccess(app, options.customerAccess);

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
