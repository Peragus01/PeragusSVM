import { buildApp } from "./app.js";
import { getEnv } from "./config/env.js";

const env = getEnv();

const app = await buildApp({
  logger: {
    level: env.LOG_LEVEL,
  },
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "Shutting down Peragus backend");
  await app.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
