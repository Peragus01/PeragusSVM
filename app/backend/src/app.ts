import sensible from "@fastify/sensible";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  await app.register(sensible);

  app.get("/health", async () => ({
    status: "ok",
    service: "peragus-backend",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  return app;
}
