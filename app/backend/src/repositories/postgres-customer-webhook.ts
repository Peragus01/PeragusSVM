import { PostgresOnboardingSubmissionRepository } from "./postgres-onboarding-submission.js";
import { RegistrationSnapshotService } from "../onboarding/customer-submission-service.js";
import type { Pool } from "pg";
import { OzavSandboxCustomerService } from "../application/ozav-sandbox-customer.js";
import type { OzavClient } from "../providers/ozav-client.js";
import { PostgresSandboxCustomerLinkRepository } from "./postgres-sandbox-customer-link.js";
import { CustomerWebhookConflict, type CustomerWebhookEvent, type CustomerWebhookProcessor, type CustomerWebhookResult } from "../webhooks/customer-event.js";

export class PostgresCustomerWebhookProcessor implements CustomerWebhookProcessor {
  constructor(private readonly pool: Pool, private readonly provider: Pick<OzavClient,
    "getCustomerCapabilities" | "createSandboxCustomer" | "getSandboxCustomerSnapshot">) {}
  async process(event: CustomerWebhookEvent, digest: string): Promise<CustomerWebhookResult> {
    if (event.livemode !== false) throw new CustomerWebhookConflict();
    const connection = await this.pool.connect();
    try {
      await connection.query("begin");
      await connection.query("set local lock_timeout = '1500ms'");
      await connection.query("set local statement_timeout = '8000ms'");
      // The event receipt and snapshot commit together. Failed refreshes leave no successful receipt.
      const inserted = await connection.query(`insert into peragus_customer_webhook_events(event_id, payload_hash, event_type)
        values($1,$2,$3) on conflict(event_id) do nothing returning event_id`, [event.id, digest, event.type]);
      if (!inserted.rows[0]) {
        const existing = await connection.query<{ payload_hash: string }>(
          "select payload_hash from peragus_customer_webhook_events where event_id=$1", [event.id]);
        if (existing.rows[0]?.payload_hash !== digest) throw new CustomerWebhookConflict();
        await connection.query("commit");
        return "duplicate";
      }
      let result: CustomerWebhookResult = "ignored";
      const data = event.data.customer;
      if (event.type === "customer.updated" && data && typeof data === "object" && !Array.isArray(data)) {
        const providerId = (data as Record<string, unknown>).id;
        if (typeof providerId !== "string" || !/^ozav_cus_[A-Za-z0-9_]{1,160}$/.test(providerId)) throw new CustomerWebhookConflict();
        // No linking by email or external_ref. Only an existing test fixture or form-based test binding can be refreshed.
        // Serialize events for the same customer before reading the latest provider observation.
        const binding = await connection.query<{ customer_id: string }>(`select l.customer_id
          from peragus_ozav_sandbox_customer_links l join peragus_customers c on c.id=l.customer_id
          where l.environment='test' and l.state='linked' and l.ozav_customer_id=$1 and c.customer_type='pf'
          for update of l`, [providerId]);
        const registration = await connection.query<{ customer_id: string }>(`select s.customer_id
          from peragus_customer_onboarding_submissions s join peragus_customers c on c.id=s.customer_id
          where s.environment='test' and s.state='linked' and s.provider_customer_id=$1 and c.customer_type='pf'
          for update of s`, [providerId]);
        if (binding.rows[0] && registration.rows[0]) throw new CustomerWebhookConflict();
        const transactionalPool = { query: connection.query.bind(connection) } as unknown as Pool;
        if (registration.rows[0]) {
          await new RegistrationSnapshotService(new PostgresOnboardingSubmissionRepository(transactionalPool), this.provider).refresh(registration.rows[0].customer_id);
          result = "processed";
        } else if (binding.rows[0]) {
          const service = new OzavSandboxCustomerService(new PostgresSandboxCustomerLinkRepository(transactionalPool), this.provider);
          await service.refresh(binding.rows[0].customer_id);
          result = "processed";
        }
      } else if (event.type === "customer.updated") {
        throw new CustomerWebhookConflict();
      }
      await connection.query(`update peragus_customer_webhook_events set disposition=$2, completed_at=now() where event_id=$1`, [event.id, result]);
      await connection.query("commit");
      return result;
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally { connection.release(); }
  }
}
