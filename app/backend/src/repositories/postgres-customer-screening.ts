import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { OzavScreening } from "../providers/ozav-client.js";
import { ScreeningError, type ScreeningRecord, type ScreeningRepository } from "../onboarding/screening-types.js";
interface Row { customer_id: string; provider_customer_id: string; idempotency_key: string; screening_id: string | null;
  observation: OzavScreening | null; revision: number; refreshed_at: Date | string | null; }
const map = (r: Row): ScreeningRecord => ({ customerId: r.customer_id, providerCustomerId: r.provider_customer_id,
  idempotencyKey: r.idempotency_key, screeningId: r.screening_id, observation: r.observation, revision: r.revision,
  refreshedAt: r.refreshed_at === null ? null : new Date(r.refreshed_at).toISOString() });
export class PostgresCustomerScreeningRepository implements ScreeningRepository {
  constructor(private readonly pool: Pool) {}
  async find(customerId: string) {
    const r = await this.pool.query<Row>("select * from peragus_customer_screenings where customer_id=$1 and environment='test'", [customerId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async reserve(customerId: string, providerCustomerId: string) {
    await this.pool.query("insert into peragus_customer_screenings(customer_id,provider_customer_id,idempotency_key) values($1,$2,$3) on conflict(customer_id) do nothing", [customerId,providerCustomerId,randomUUID()]);
    const row = await this.find(customerId);
    if (!row || row.providerCustomerId !== providerCustomerId) throw new ScreeningError("SCREENING_CONFLICT");
    return row;
  }
  async save(row: ScreeningRecord, observation: OzavScreening) {
    if (observation.customerId !== row.providerCustomerId || (row.screeningId && row.screeningId !== observation.id)) throw new ScreeningError("SCREENING_CONFLICT");
    try {
      const r = await this.pool.query<Row>(`update peragus_customer_screenings set screening_id=$3,observation=$4::jsonb,
        revision=revision+1,refreshed_at=now(),updated_at=now()
        where customer_id=$1 and provider_customer_id=$2 and environment='test' and revision=$5
        and (screening_id is null or screening_id=$3) returning *`,
        [row.customerId,row.providerCustomerId,observation.id,JSON.stringify(observation),row.revision]);
      if (!r.rows[0]) throw new ScreeningError("SCREENING_CONFLICT"); return map(r.rows[0]);
    } catch (error) { if ((error as {code?:string}).code === "23505") throw new ScreeningError("SCREENING_CONFLICT"); throw error; }
  }
}
