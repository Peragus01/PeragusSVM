import type { Pool } from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import {inControlledTransaction} from "../operations/runtime-controls.js";
import type { OzavCustomerSnapshot } from "../providers/ozav-client.js";
import { SubmissionError, type SubmissionAttestation, type SubmissionRecord, type SubmissionRepository } from "../onboarding/submission-types.js";
interface Row { id: string; customer_id: string; draft_version: number; terms_session_id: string; request_hash: string; idempotency_key: string;
  encrypted_payload: unknown; state: "pending" | "linked"; provider_customer_id: string | null; provider_status: string | null;
  verification_mode: "full" | "reliance" | null; provider_snapshot: OzavCustomerSnapshot | null; snapshot_version: number; refreshed_at: Date | string | null;
  attestation?: SubmissionAttestation | null; }
const map = (r: Row): SubmissionRecord => ({ id: r.id, customerId: r.customer_id, draftVersion: r.draft_version, termsSessionId: r.terms_session_id,
  requestHash: r.request_hash, idempotencyKey: r.idempotency_key, encryptedPayload: r.encrypted_payload, state: r.state,
  providerId: r.provider_customer_id, providerStatus: r.provider_status, verificationMode: r.verification_mode,
  snapshot: r.provider_snapshot, snapshotVersion: r.snapshot_version, refreshedAt: r.refreshed_at == null ? null : new Date(r.refreshed_at).toISOString(),
  attestation: r.attestation ?? null });
export class PostgresOnboardingSubmissionRepository implements SubmissionRepository {
  private readonly e: RowEnvironment;
  constructor(private readonly pool: Pool, mode: MoneyMode) { this.e = rowEnvironment(mode); }
  async find(customerId: string) {
    const r = await this.pool.query<Row>(`select * from peragus_customer_onboarding_submissions where customer_id=$1 and environment='${this.e.mode}'`, [customerId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async reserve(record: SubmissionRecord) {
    await this.pool.query(`insert into peragus_customer_onboarding_submissions
      (id,customer_id,draft_version,terms_session_id,request_hash,idempotency_key,encrypted_payload,environment,attestation,attested_at)
      values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,case when $9::text is null then null else now() end) on conflict(customer_id) do nothing`,
      [record.id, record.customerId, record.draftVersion, record.termsSessionId, record.requestHash, record.idempotencyKey, JSON.stringify(record.encryptedPayload), this.e.mode,
        record.attestation ?? null]);
    const saved = await this.find(record.customerId);
    if (!saved || saved.requestHash !== record.requestHash || saved.draftVersion !== record.draftVersion || saved.termsSessionId !== record.termsSessionId) throw new SubmissionError("ONBOARDING_CONFLICT");
    return saved;
  }
  /**
   * Gate before every registration POST (first attempt or retry of the frozen request):
   * reads the kill switch onboarding `for share` and touches the pending row, in one transaction.
   */
  async claimAttempt(record: SubmissionRecord) {
    const r = await inControlledTransaction(this.pool, "onboarding", client => client.query(`update peragus_customer_onboarding_submissions set updated_at=now()
      where id=$1 and customer_id=$2 and request_hash=$3 and environment='${this.e.mode}' returning id`, [record.id, record.customerId, record.requestHash]));
    if (!r.rows[0]) throw new SubmissionError("ONBOARDING_CONFLICT");
  }
  async complete(record: SubmissionRecord, result: { id: string; status: string; verificationMode: "full" }) {
    try {
      const r = await this.pool.query<Row>(`update peragus_customer_onboarding_submissions
        set state='linked',provider_customer_id=$3,provider_status=case when refreshed_at is null then $4 else provider_status end,
          verification_mode=case when refreshed_at is null then 'full' else verification_mode end,updated_at=now()
        where customer_id=$1 and request_hash=$2 and environment='${this.e.mode}'
          and (provider_customer_id is null or provider_customer_id=$3)
          and not exists(select 1 from peragus_ozav_sandbox_customer_links where ozav_customer_id=$3)
        returning *`, [record.customerId, record.requestHash, result.id, result.status]);
      if (!r.rows[0]) throw new SubmissionError("ONBOARDING_CONFLICT"); return map(r.rows[0]);
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new SubmissionError("ONBOARDING_CONFLICT"); throw error; }
  }
  async saveSnapshot(customerId: string, providerId: string, version: number, snapshot: OzavCustomerSnapshot) {
    const r = await this.pool.query<Row>(`update peragus_customer_onboarding_submissions set provider_snapshot=$4::jsonb,
      provider_status=$5,verification_mode=$6,snapshot_version=snapshot_version+1,refreshed_at=now(),updated_at=now()
      where customer_id=$1 and provider_customer_id=$2 and snapshot_version=$3 and state='linked' and environment='${this.e.mode}' returning *`,
      [customerId, providerId, version, JSON.stringify(snapshot), snapshot.provider_status, snapshot.verification_mode]);
    if (!r.rows[0]) throw new SubmissionError("ONBOARDING_CONFLICT"); return map(r.rows[0]);
  }
}
