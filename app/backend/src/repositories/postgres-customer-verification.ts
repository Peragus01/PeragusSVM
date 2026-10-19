import type { Pool } from "pg";
import type { OzavVerification } from "../providers/ozav-client.js";
import { VerificationError, type VerificationRecord, type VerificationRepository, type SimulationOutcome } from "../onboarding/verification-types.js";
interface Row { customer_id: string; provider_customer_id: string; verification_id: string | null; create_attempted: boolean;
  observation: OzavVerification | null; revision: number; refreshed_at: Date | string | null; last_simulated_outcome: SimulationOutcome | null; }
const map = (r: Row): VerificationRecord => ({ customerId: r.customer_id, providerCustomerId: r.provider_customer_id, verificationId: r.verification_id,
  createAttempted: r.create_attempted, observation: r.observation, revision: r.revision,
  refreshedAt: r.refreshed_at === null ? null : new Date(r.refreshed_at).toISOString(), lastSimulatedOutcome: r.last_simulated_outcome });
export class PostgresCustomerVerificationRepository implements VerificationRepository {
  constructor(private readonly pool: Pool) {}
  async find(customerId: string) {
    const r = await this.pool.query<Row>("select * from peragus_customer_verifications where customer_id=$1 and environment='test'", [customerId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async reserve(customerId: string, providerCustomerId: string) {
    await this.pool.query("insert into peragus_customer_verifications(customer_id,provider_customer_id) values($1,$2) on conflict(customer_id) do nothing", [customerId, providerCustomerId]);
    const row = await this.find(customerId);
    if (!row || row.providerCustomerId !== providerCustomerId) throw new VerificationError("VERIFICATION_CONFLICT");
    return row;
  }
  async claimCreate(customerId: string) {
    const r = await this.pool.query("update peragus_customer_verifications set create_attempted=true,updated_at=now() where customer_id=$1 and environment='test' and not create_attempted and verification_id is null returning customer_id", [customerId]);
    return Boolean(r.rows[0]);
  }
  async save(record: VerificationRecord, observation: OzavVerification, outcome?: SimulationOutcome) {
    if (observation.customerId !== record.providerCustomerId || (record.verificationId && record.verificationId !== observation.id)) throw new VerificationError("VERIFICATION_CONFLICT");
    try {
      const r = await this.pool.query<Row>(`update peragus_customer_verifications set verification_id=$3, observation=$4::jsonb,
        revision=revision+1,refreshed_at=now(),updated_at=now(),last_simulated_outcome=coalesce($6,last_simulated_outcome)
        where customer_id=$1 and provider_customer_id=$2 and environment='test' and revision=$5
          and (verification_id is null or verification_id=$3) returning *`,
        [record.customerId, record.providerCustomerId, observation.id, JSON.stringify(observation), record.revision, outcome ?? null]);
      if (!r.rows[0]) throw new VerificationError("VERIFICATION_CONFLICT"); return map(r.rows[0]);
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new VerificationError("VERIFICATION_CONFLICT"); throw error; }
  }
}
