import "dotenv/config";
import { getEnv } from "./config/env.js";
import { assertSmokeTestSafety } from "./jobs/worker-smoke-test.js";
import { createDatabasePool } from "./database/pool.js";
import { notificationConfig } from "./notifications/config.js";
import { OnboardingEmailProcessor } from "./notifications/onboarding-email.js";
import { ResendSender } from "./notifications/resend.js";
import type { Customer } from "./auth/customer-access.js";
import { PostgresCustomerRepository } from "./repositories/postgres-customer-repository.js";
import { PostgresOnboardingOverviewRepository } from "./repositories/postgres-onboarding-overview.js";
import { PostgresOnboardingSubmissionRepository } from "./repositories/postgres-onboarding-submission.js";
import { PostgresCustomerVerificationRepository } from "./repositories/postgres-customer-verification.js";
import { PostgresCustomerScreeningRepository } from "./repositories/postgres-customer-screening.js";
import { CustomerVerificationService } from "./onboarding/customer-verification-service.js";
import { CustomerScreeningService } from "./onboarding/customer-screening-service.js";
import { RegistrationSnapshotService } from "./onboarding/customer-submission-service.js";
import { OzavClient } from "./providers/ozav-client.js";

const config = notificationConfig(),
  env = getEnv();
if (!config.enabled) throw new Error("ONBOARDING_EMAILS_DISABLED");
assertSmokeTestSafety(env);
if (
  env.SUPABASE_URL !== "https://lybdkqkbwlfwvmmvstzi.supabase.co" ||
  !env.DATABASE_URL ||
  !env.OZAV_API_KEY ||
  env.CUSTOMER_VERIFICATION_SIMULATION_ENABLED ||
  env.CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED
)
  throw new Error("ONBOARDING_EMAIL_STAGING_REQUIRED");
const pool = createDatabasePool(env.DATABASE_URL, env.DATABASE_SSL);
const customers = new PostgresCustomerRepository(pool),
  facts = new PostgresOnboardingOverviewRepository(pool);
const submissions = new PostgresOnboardingSubmissionRepository(pool),
  provider = new OzavClient({
    apiKey: env.OZAV_API_KEY,
    attempts: 1,
    timeoutMs: 5000,
  });
const verifications = new PostgresCustomerVerificationRepository(pool),
  screenings = new PostgresCustomerScreeningRepository(pool);
const verification = new CustomerVerificationService(
    verifications,
    submissions,
    provider,
  ),
  screening = new CustomerScreeningService(screenings, submissions, provider);
async function fresh(customer: Customer) {
  await new RegistrationSnapshotService(submissions, provider).refresh(
    customer.id,
  );
  if ((await verifications.find(customer.id))?.verificationId)
    await verification.refresh(customer.id);
  if ((await screenings.find(customer.id))?.screeningId)
    await screening.refresh(customer.id);
  return facts.read(customer.id);
}
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true;
  });
async function tick() {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = Boolean(
      (await client.query("select pg_try_advisory_lock(808613,37) as locked"))
        .rows[0]?.locked,
    );
    if (!locked) return;
    await client.query(
      "delete from peragus_onboarding_email_workers where not(owner_user_id=any($1::uuid[]))",
      [config.owners],
    );
    const processor = new OnboardingEmailProcessor(
      client,
      new ResendSender(config.key!),
      config.from!,
      config.accountUrl!,
      fresh,
    );
    for (const owner of config.owners) {
      try {
        const customer = await customers.findByOwner(owner);
        if (!customer || customer.type !== "pf" || customer.suspended) continue;
        const address = await client.query<{ email: string }>(
          "select email from auth.users where id=$1 and email_confirmed_at is not null and email is not null",
          [owner],
        );
        if (!address.rows[0]) continue;
        await processor.process(customer, address.rows[0].email);
        await client.query(
          "insert into peragus_onboarding_email_workers(owner_user_id,heartbeat_at) values($1,now()) on conflict(owner_user_id) do update set heartbeat_at=excluded.heartbeat_at",
          [owner],
        );
      } catch {
        await client.query(
          "delete from peragus_onboarding_email_workers where owner_user_id=$1",
          [owner],
        );
        console.warn(
          JSON.stringify({ event: "onboarding_email_cycle_unconfirmed" }),
        );
      }
    }
  } finally {
    try {
      if (locked) await client.query("select pg_advisory_unlock(808613,37)");
    } finally {
      client.release();
    }
  }
}
try {
  while (!stopping) {
    await tick();
    for (let i = 0; i < 60 && !stopping; i++)
      await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} catch {
  console.error(JSON.stringify({ event: "onboarding_email_worker_failed" }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
