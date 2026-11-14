import type { Pool } from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import {inControlledTransaction} from "../operations/runtime-controls.js";
import type { OzavVerification } from "../providers/ozav-client.js";
import { VerificationError, type VerificationRecord, type VerificationRepository, type SimulationOutcome } from "../onboarding/verification-types.js";
interface Row { customer_id: string; provider_customer_id: string; verification_id: string | null; create_attempted: boolean;
  observation: OzavVerification | null; revision: number; refreshed_at: Date | string | null; last_simulated_outcome: SimulationOutcome | null;
  previous_verification_ids?: string[] | null; }
const map = (r: Row): VerificationRecord => ({ customerId: r.customer_id, providerCustomerId: r.provider_customer_id, verificationId: r.verification_id,
  createAttempted: r.create_attempted, observation: r.observation, revision: r.revision,
  refreshedAt: r.refreshed_at === null ? null : new Date(r.refreshed_at).toISOString(), lastSimulatedOutcome: r.last_simulated_outcome,
  previousVerificationIds: r.previous_verification_ids ?? [] });
export class PostgresCustomerVerificationRepository implements VerificationRepository {
  private readonly e: RowEnvironment;
  constructor(private readonly pool: Pool, mode: MoneyMode) { this.e = rowEnvironment(mode); }
  async find(customerId: string) {
    const r = await this.pool.query<Row>(`select * from peragus_customer_verifications where customer_id=$1 and environment='${this.e.mode}'`, [customerId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async reserve(customerId: string, providerCustomerId: string) {
    await this.pool.query("insert into peragus_customer_verifications(customer_id,provider_customer_id,environment) values($1,$2,$3) on conflict(customer_id) do nothing", [customerId, providerCustomerId, this.e.mode]);
    const row = await this.find(customerId);
    if (!row || row.providerCustomerId !== providerCustomerId) throw new VerificationError("VERIFICATION_CONFLICT");
    return row;
  }
  async claimCreate(customerId: string) {
    // Kill switch onboarding, read `for share` in the claim's own transaction (before the verification POST).
    const r = await inControlledTransaction(this.pool, "onboarding", client => client.query(`update peragus_customer_verifications set create_attempted=true,updated_at=now() where customer_id=$1 and environment='${this.e.mode}' and not create_attempted and verification_id is null returning customer_id`, [customerId]));
    return Boolean(r.rows[0]);
  }
  async releaseCreate(customerId: string, olderThanMs?: number) {
    const r = await this.pool.query(`update peragus_customer_verifications set create_attempted=false,updated_at=now() where customer_id=$1 and environment='${this.e.mode}' and create_attempted and verification_id is null
      and ($2::double precision is null or updated_at<=now()-make_interval(secs=>$2::double precision/1000)) returning customer_id`, [customerId, olderThanMs ?? null]);
    return r.rows.length === 1;
  }
  async resetEnded(customerId: string, verificationId: string) {
    await this.pool.query(`update peragus_customer_verifications set previous_verification_ids=array_append(previous_verification_ids,verification_id),
      verification_id=null,observation=null,create_attempted=false,revision=revision+1,updated_at=now()
      where customer_id=$1 and environment='${this.e.mode}' and verification_id=$2 and observation->>'status' in ('expired','failed')`, [customerId, verificationId]);
  }
  async save(record: VerificationRecord, observation: OzavVerification, outcome?: SimulationOutcome) {
    if (observation.customerId !== record.providerCustomerId || (record.verificationId && record.verificationId !== observation.id)) throw new VerificationError("VERIFICATION_CONFLICT");
    try {
      const r = await this.pool.query<Row>(`update peragus_customer_verifications set verification_id=$3, observation=$4::jsonb,
        revision=revision+1,refreshed_at=now(),updated_at=now(),last_simulated_outcome=coalesce($6,last_simulated_outcome)
        where customer_id=$1 and provider_customer_id=$2 and environment='${this.e.mode}' and revision=$5
          and (verification_id is null or verification_id=$3) returning *`,
        [record.customerId, record.providerCustomerId, observation.id, JSON.stringify(observation), record.revision, outcome ?? null]);
      if (!r.rows[0]) throw new VerificationError("VERIFICATION_CONFLICT"); return map(r.rows[0]);
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new VerificationError("VERIFICATION_CONFLICT"); throw error; }
  }
}
