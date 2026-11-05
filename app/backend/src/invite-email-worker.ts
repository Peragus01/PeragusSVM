import "dotenv/config";
import { getEnv } from "./config/env.js";
import { assertNotificationEnvironment } from "./notifications/runtime-safety.js";
import { createDatabasePool } from "./database/pool.js";
import { InviteEmailCipher } from "./invites/invite-email-cipher.js";
import { InviteEmailProvider } from "./invites/invite-email-provider.js";
import { processInviteEmail } from "./invites/invite-email-processor.js";
const env = getEnv();
if (
  !env.INVITE_EMAIL_OUTBOX_ENABLED ||
  !process.env.RESEND_API_KEY?.match(/^re_[A-Za-z0-9_]+$/)
)
  throw Error("INVITE_EMAIL_WORKER_CONFIG_REQUIRED");
assertNotificationEnvironment(env, {
  ...process.env,
  ONBOARDING_EMAIL_DEPLOYMENT_ENV: env.PERAGUS_DEPLOYMENT_ENV,
});
const pool = createDatabasePool(env.DATABASE_URL!, env.DATABASE_SSL);
const cipher = new InviteEmailCipher(
  env.INVITE_EMAIL_ENCRYPTION_KEY!,
  env.INVITE_EMAIL_ENCRYPTION_KEY_ID!,
);
const provider = new InviteEmailProvider(
  process.env.RESEND_API_KEY,
  fetch,
  false,
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true;
  });
console.info(
  JSON.stringify({ event: "invite_email_worker_ready", environment: "test" }),
);
try {
  while (!stopping) {
    const client = await pool.connect();
    try {
      await processInviteEmail(client, cipher, provider);
    } catch {
      console.warn(JSON.stringify({ event: "invite_email_cycle_unconfirmed" }));
    } finally {
      client.release();
    }
    for (let i = 0; i < 10 && !stopping; i++)
      await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await pool.end();
}
