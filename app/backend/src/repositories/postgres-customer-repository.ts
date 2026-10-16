import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Customer, CustomerRepository } from "../auth/customer-access.js";
interface Row {
  id: string; owner_user_id: string; customer_type: "pf" | "pj"; display_name: string;
  verification_status: Customer["verificationStatus"]; suspended: boolean;
}
const map = (row: Row): Customer => ({
  id: row.id, ownerUserId: row.owner_user_id, type: row.customer_type,
  displayName: row.display_name, verificationStatus: row.verification_status, suspended: row.suspended,
});
export class PostgresCustomerRepository implements CustomerRepository {
  constructor(private readonly pool: Pool) {}
  async findByOwner(userId: string): Promise<Customer | null> {
    const result = await this.pool.query<Row>("select * from peragus_customers where owner_user_id = $1", [userId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async createOrGet(input: { ownerUserId: string; type: "pf" | "pj"; displayName: string }) {
    const result = await this.pool.query<Row>(`insert into peragus_customers
      (id, owner_user_id, customer_type, display_name) values ($1, $2, $3, $4)
      on conflict (owner_user_id) do nothing returning *`,
    [randomUUID(), input.ownerUserId, input.type, input.displayName]);
    const customer = result.rows[0] ? map(result.rows[0]) : await this.findByOwner(input.ownerUserId);
    if (!customer) throw new Error("Customer was not found after insert");
    return { customer, created: Boolean(result.rows[0]) };
  }
  async ownsSettlement(customerId: string, settlementId: string): Promise<boolean> {
    const result = await this.pool.query("select 1 from settlements where id = $1 and customer_id = $2", [settlementId, customerId]);
    return result.rowCount === 1;
  }
}
