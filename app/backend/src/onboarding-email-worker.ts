import "dotenv/config";
import { getEnv } from "./config/env.js";
import { moneyModeFor } from "./config/money-environment.js";
import {
  assertNotificationEnvironment,
  deploymentConfigurationAudit,
  notificationFailure,
  notificationStep,
} from "./notifications/runtime-safety.js";
import { randomUUID } from "node:crypto";
import { createDatabasePool } from "./database/pool.js";
import { verifyDatabaseConnection } from "./database/readiness.js";
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

async function main() {
  console.info(JSON.stringify(deploymentConfigurationAudit()));
  const config = notificationConfig();
  if (!config.enabled) {
    try {
      assertNotificationEnvironment(getEnv(), process.env);
      console.info(
        JSON.stringify({
          event: "onboarding_email_configuration_verified",
          environment: process.env.ONBOARDING_EMAIL_DEPLOYMENT_ENV,
          sending_enabled: false,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify(
          notificationFailure(
            error,
            "disabled_configuration_audit",
            process.env.ONBOARDING_EMAIL_DEPLOYMENT_ENV ?? "unconfigured",
            randomUUID(),
          ),
        ),
      );
    }
    console.info(
      JSON.stringify({
        event: "onboarding_email_worker_disabled",
        environment:
          process.env.ONBOARDING_EMAIL_DEPLOYMENT_ENV ?? "unconfigured",
        sending_enabled: false,
      }),
    );
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => {}, 60000);
      const stop = () => {
        clearInterval(keepAlive);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  const env = await notificationStep("configuration", async () => getEnv());
  const environment = assertNotificationEnvironment(env, process.env);
  const pool = createDatabasePool(env.DATABASE_URL!, env.DATABASE_SSL);
  const customers = new PostgresCustomerRepository(pool),
    facts = new PostgresOnboardingOverviewRepository(pool, moneyModeFor(env));
  const submissions = new PostgresOnboardingSubmissionRepository(pool, moneyModeFor(env)),
    provider = new OzavClient({
      apiKey: env.OZAV_API_KEY!,
      mode: moneyModeFor(env),
      attempts: 1,
      timeoutMs: 5000,
    });
  const verifications = new PostgresCustomerVerificationRepository(pool, moneyModeFor(env)),
    screenings = new PostgresCustomerScreeningRepository(pool, moneyModeFor(env));
  const verification = new CustomerVerificationService(
      verifications,
      submissions,
      provider,
    ),
    screening = new CustomerScreeningService(screenings, submissions, provider);
  async function fresh(customer: Customer) {
    await notificationStep("provider_registration", () =>
      new RegistrationSnapshotService(submissions, provider).refresh(
        customer.id,
      ),
    );
    if ((await verifications.find(customer.id))?.verificationId)
      await notificationStep("provider_verification", () =>
        verification.refresh(customer.id),
      );
    if ((await screenings.find(customer.id))?.screeningId)
      await notificationStep("provider_screening", () =>
        screening.refresh(customer.id),
      );
    return notificationStep("stored_overview", () => facts.read(customer.id));
  }

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      stopping = true;
    });
  async function tick() {
    const correlationId = randomUUID();
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
        fresh, moneyModeFor(env),
      );
      for (const owner of config.owners) {
        try {
          const customer = await customers.findByOwner(owner);
          if (!customer || customer.type !== "pf" || customer.suspended)
            continue;
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
        } catch (error) {
          await client.query(
            "delete from peragus_onboarding_email_workers where owner_user_id=$1",
            [owner],
          );
          console.warn(
            JSON.stringify(
              notificationFailure(
                error,
                "customer_cycle",
                environment,
                correlationId,
              ),
            ),
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
    await notificationStep("database_readiness", () =>
      verifyDatabaseConnection(pool),
    );
    // Fail before advertising readiness if the deployed schema is incomplete.
    const required = [
      "peragus_customers",
      "peragus_onboarding_email_workers",
      "peragus_onboarding_email_outbox",
      "peragus_individual_onboarding_drafts",
      "peragus_customer_onboarding_submissions",
      "peragus_customer_terms_sessions",
      "peragus_customer_verifications",
      "peragus_customer_screenings",
      "peragus_customer_wallets",
    ];
    const schema = await notificationStep("schema_readiness", () =>
      pool.query(
        "select bool_and(to_regclass('public.' || name) is not null) as ready from unnest($1::text[]) as name",
        [required],
      ),
    );
    if (!schema.rows[0]?.ready) throw new Error("ONBOARDING_SCHEMA_REQUIRED");
    console.info(
      JSON.stringify({
        event: "onboarding_email_worker_ready",
        environment,
        provider_environment: "test",
        restricted_recipients: true,
      }),
    );
    while (!stopping) {
      try {
        await tick();
      } catch (error) {
        console.error(
          JSON.stringify(
            notificationFailure(error, "cycle", environment, randomUUID()),
          ),
        );
      }
      for (let i = 0; i < 60 && !stopping; i++)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify(
      notificationFailure(
        error,
        "worker",
        process.env.ONBOARDING_EMAIL_DEPLOYMENT_ENV ?? "unconfigured",
        randomUUID(),
      ),
    ),
  );
  process.exitCode = 1;
});
