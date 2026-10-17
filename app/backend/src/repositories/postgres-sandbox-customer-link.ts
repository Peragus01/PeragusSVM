import type { Pool } from "pg";
import { SandboxCustomerError, type SandboxCustomerLink, type SandboxCustomerLinkRepository } from "../application/ozav-sandbox-customer.js";
import type { OzavSandboxCustomer } from "../providers/ozav-client.js";
interface Row {
  customer_id: string; environment: "test"; idempotency_key: string; request_hash: string;
  state: "pending" | "linked"; ozav_customer_id: string | null; provider_status: string | null;
  verification_mode: "full" | "reliance" | null;
}
const map = (r: Row): SandboxCustomerLink => ({ customerId: r.customer_id, environment: r.environment,
  idempotencyKey: r.idempotency_key, requestHash: r.request_hash, state: r.state,
  ozavCustomerId: r.ozav_customer_id, providerStatus: r.provider_status, verificationMode: r.verification_mode });
export class PostgresSandboxCustomerLinkRepository implements SandboxCustomerLinkRepository {
  constructor(private readonly pool: Pool) {}
  async find(customerId: string) {
    const r = await this.pool.query<Row>("select * from peragus_ozav_sandbox_customer_links where customer_id=$1 and environment='test'", [customerId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async reserve(customerId: string, hash: string, key: string) {
    await this.pool.query(`insert into peragus_ozav_sandbox_customer_links(customer_id, request_hash, idempotency_key)
      values($1,$2,$3) on conflict(customer_id) do nothing`, [customerId, hash, key]);
    const row = await this.find(customerId);
    if (!row || row.requestHash !== hash || row.idempotencyKey !== key) throw new SandboxCustomerError("SANDBOX_CUSTOMER_CONFLICT");
    return row;
  }
  async complete(customerId: string, hash: string, result: OzavSandboxCustomer) {
    try {
      const r = await this.pool.query<Row>(`update peragus_ozav_sandbox_customer_links
        set state='linked', ozav_customer_id=$3, provider_status=$4, verification_mode=$5, updated_at=now()
        where customer_id=$1 and environment='test' and request_hash=$2
          and (ozav_customer_id is null or ozav_customer_id=$3) returning *`,
      [customerId, hash, result.id, result.status, result.verificationMode]);
      if (!r.rows[0]) throw new SandboxCustomerError("SANDBOX_CUSTOMER_CONFLICT");
      return map(r.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new SandboxCustomerError("SANDBOX_CUSTOMER_CONFLICT");
      throw error;
    }
  }
}
