import sensible from "@fastify/sensible";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { InMemorySettlementRepository } from "./repositories/in-memory-settlement-repository.js";
import type { SettlementRepository } from "./repositories/settlement-repository.js";
import { registerSettlementRoutes } from "./routes/settlements.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  settlementRepository?: SettlementRepository;
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

  app.get("/health", async () => ({
    status: "ok",
    service: "peragus-backend",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  await registerSettlementRoutes(app, {
    repository:
      options.settlementRepository
      ?? new InMemorySettlementRepository(),
    now: options.now ?? (() => new Date()),
  });

  return app;
}
