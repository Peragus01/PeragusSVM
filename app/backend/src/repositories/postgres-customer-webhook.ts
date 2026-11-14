import { PostgresOnboardingSubmissionRepository } from "./postgres-onboarding-submission.js";
import { RegistrationSnapshotService } from "../onboarding/customer-submission-service.js";
import { CustomerVerificationService } from "../onboarding/customer-verification-service.js";
import { PostgresCustomerVerificationRepository } from "./postgres-customer-verification.js";
import type { Pool } from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import { OzavSandboxCustomerService } from "../application/ozav-sandbox-customer.js";
import type { OzavClient } from "../providers/ozav-client.js";
import { PostgresSandboxCustomerLinkRepository } from "./postgres-sandbox-customer-link.js";
import type { PurchaseProgression } from "../purchases/purchase-progression.js";
import { CustomerWebhookConflict, type CustomerWebhookEvent, type CustomerWebhookProcessor, type CustomerWebhookResult } from "../webhooks/customer-event.js";

export class PostgresCustomerWebhookProcessor implements CustomerWebhookProcessor {
  private readonly e: RowEnvironment;
  constructor(private readonly pool: Pool, private readonly provider: Pick<OzavClient,
    "getCustomerCapabilities" | "createSandboxCustomer" | "getSandboxCustomerSnapshot" | "getCustomerVerification">, mode: MoneyMode,
    private readonly transfers?: Pick<PurchaseProgression, "refreshTransfer">) { this.e = rowEnvironment(mode); }
  async process(event: CustomerWebhookEvent, digest: string): Promise<CustomerWebhookResult> {
    // An event from the other environment never changes state here.
    if (event.livemode !== (this.e.mode === "live")) throw new CustomerWebhookConflict();
    if (TRANSFER_EVENTS.has(event.type)) return this.processTransfer(event, digest);
    const connection = await this.pool.connect();
    try {
      await connection.query("begin");
      await connection.query("set local lock_timeout = '1500ms'");
      await connection.query("set local statement_timeout = '8000ms'");
      // The event receipt and snapshot commit together. Failed refreshes leave no successful receipt.
      const inserted = await connection.query(`insert into peragus_customer_webhook_events(event_id, payload_hash, event_type, environment)
        values($1,$2,$3,$4) on conflict(event_id) do nothing returning event_id`, [event.id, digest, event.type, this.e.mode]);
      if (!inserted.rows[0]) {
        const existing = await connection.query<{ payload_hash: string }>(
          "select payload_hash from peragus_customer_webhook_events where event_id=$1", [event.id]);
        if (existing.rows[0]?.payload_hash !== digest) throw new CustomerWebhookConflict();
        await connection.query("commit");
        return "duplicate";
      }
      let result: CustomerWebhookResult = "ignored";
      // verification.updated names the customer whose registration snapshot (which carries the
      // verification status) is re-read by GET, exactly like customer.updated.
      const verification = event.type === "verification.updated" ? event.data.verification : undefined;
      const data = verification && typeof verification === "object" && !Array.isArray(verification)
        ? { id: (verification as Record<string, unknown>).customer_id } : event.data.customer;
      if ((event.type === "customer.updated" || event.type === "verification.updated") && data && typeof data === "object" && !Array.isArray(data)) {
        const providerId = (data as Record<string, unknown>).id;
        if (typeof providerId !== "string" || !/^ozav_cus_[A-Za-z0-9_]{1,160}$/.test(providerId)) throw new CustomerWebhookConflict();
        // No linking by email or external_ref. Only an existing test fixture or form-based test binding can be refreshed.
        // Serialize events for the same customer before reading the latest provider observation.
        const binding = await connection.query<{ customer_id: string }>(`select l.customer_id
          from peragus_ozav_sandbox_customer_links l join peragus_customers c on c.id=l.customer_id
          where l.environment='${this.e.mode}' and l.state='linked' and l.ozav_customer_id=$1 and c.customer_type='pf'
          for update of l`, [providerId]);
        const registration = await connection.query<{ customer_id: string }>(`select s.customer_id
          from peragus_customer_onboarding_submissions s join peragus_customers c on c.id=s.customer_id
          where s.environment='${this.e.mode}' and s.state='linked' and s.provider_customer_id=$1 and c.customer_type='pf'
          for update of s`, [providerId]);
        if (binding.rows[0] && registration.rows[0]) throw new CustomerWebhookConflict();
        const transactionalPool = { query: connection.query.bind(connection) } as unknown as Pool;
        if (registration.rows[0]) {
          const customerId = registration.rows[0].customer_id;
          const submissions = new PostgresOnboardingSubmissionRepository(transactionalPool, this.e.mode);
          const verifications = new PostgresCustomerVerificationRepository(transactionalPool, this.e.mode);
          if (event.type === "verification.updated" && (await verifications.find(customerId))?.verificationId) {
            // The event only names the verification: its status and checks are re-read by
            // GET /verifications/{id} (the GET is the truth), then the registration snapshot.
            // Only refresh() is used, which needs capabilities, the verification GET and the customer GET.
            await new CustomerVerificationService(verifications, submissions,
              this.provider as ConstructorParameters<typeof CustomerVerificationService>[2], this.e.mode).refresh(customerId);
          } else {
            await new RegistrationSnapshotService(submissions, this.provider, this.e.mode).refresh(customerId);
          }
          result = "processed";
        } else if (binding.rows[0]) {
          const service = new OzavSandboxCustomerService(new PostgresSandboxCustomerLinkRepository(transactionalPool, this.e.mode), this.provider);
          await service.refresh(binding.rows[0].customer_id);
          result = "processed";
        }
      } else if (event.type === "customer.updated" || event.type === "verification.updated") {
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
  /**
   * transfer.updated|completed|failed: the body only names the transfer; its state is
   * re-read by GET. The provider call runs outside a database transaction, and the
   * refresh is idempotent, so the receipt is recorded after it (a failure leaves no
   * receipt and the sender retries).
   */
  private async processTransfer(event: CustomerWebhookEvent, digest: string): Promise<CustomerWebhookResult> {
    const prior = await this.pool.query<{ payload_hash: string }>(
      "select payload_hash from peragus_customer_webhook_events where event_id=$1", [event.id]);
    if (prior.rows[0]) {
      if (prior.rows[0].payload_hash !== digest) throw new CustomerWebhookConflict();
      return "duplicate";
    }
    const transfer = event.data.transfer;
    if (!transfer || typeof transfer !== "object" || Array.isArray(transfer)) throw new CustomerWebhookConflict();
    const { id, metadata } = transfer as Record<string, unknown>;
    if (typeof id !== "string" || !/^ozav_tr_[A-Za-z0-9_]{1,160}$/.test(id)) throw new CustomerWebhookConflict();
    const hint = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).peragus_pix_id : null;
    const result: CustomerWebhookResult = this.transfers
      ? await this.transfers.refreshTransfer(id, typeof hint === "string" ? hint : null, "system:webhook") : "ignored";
    const inserted = await this.pool.query(`insert into peragus_customer_webhook_events(event_id, payload_hash, event_type, environment, disposition, completed_at)
      values($1,$2,$3,$4,$5,now()) on conflict(event_id) do nothing returning event_id`, [event.id, digest, event.type, this.e.mode, result]);
    if (!inserted.rows[0]) {
      const existing = await this.pool.query<{ payload_hash: string }>(
        "select payload_hash from peragus_customer_webhook_events where event_id=$1", [event.id]);
      if (existing.rows[0]?.payload_hash !== digest) throw new CustomerWebhookConflict();
      return "duplicate";
    }
    return result;
  }
}
const TRANSFER_EVENTS = new Set(["transfer.updated", "transfer.completed", "transfer.failed"]);
