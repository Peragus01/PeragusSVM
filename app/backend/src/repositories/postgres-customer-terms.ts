import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { TermsFlowError, type TermsRecord, type TermsRepository } from "../onboarding/terms-types.js";
import type { TermsEnvelope } from "../onboarding/terms-vault.js";
interface Row { id: string; customer_id: string; active: boolean; state: TermsRecord["state"]; generation: number;
  idempotency_key: string; lease_until: Date | string; encrypted_token: unknown; terms_url: string | null;
  terms_version: string | null; expires_at: Date | string | null; encrypted_acceptance: unknown; accepted_at: Date | string | null; }
const time = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const map = (row: Row): TermsRecord => ({ id: row.id, customerId: row.customer_id, active: row.active, state: row.state,
  generation: row.generation, idempotencyKey: row.idempotency_key, leaseUntil: time(row.lease_until)!, encryptedToken: row.encrypted_token,
  termsUrl: row.terms_url, termsVersion: row.terms_version, expiresAt: time(row.expires_at), encryptedAcceptance: row.encrypted_acceptance, acceptedAt: time(row.accepted_at) });
export class PostgresCustomerTermsRepository implements TermsRepository {
  constructor(private readonly pool: Pool) {}
  async findActive(customerId: string) {
    const r = await this.pool.query<Row>("select * from peragus_customer_terms_sessions where customer_id=$1 and environment='test' and active", [customerId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async findOwned(customerId: string, id: string) {
    const r = await this.pool.query<Row>("select * from peragus_customer_terms_sessions where customer_id=$1 and id=$2 and environment='test'", [customerId, id]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async reserve(customerId: string, renewId: string | undefined, now: Date) {
    const db = await this.pool.connect();
    try {
      await db.query("begin"); await db.query("set local lock_timeout='1500ms'");
      const existing = await db.query<Row>("select * from peragus_customer_terms_sessions where customer_id=$1 and environment='test' and active for update", [customerId]);
      const prior = existing.rows[0] ? map(existing.rows[0]) : null;
      const lease = new Date(now.getTime() + 30000).toISOString();
      if (renewId) {
        if (!prior || prior.id !== renewId || prior.state === "accepting" || !(prior.state === "uncertain" || (prior.expiresAt && Date.parse(prior.expiresAt) <= now.getTime()))) throw new TermsFlowError("TERMS_SESSION_CONFLICT");
        await db.query("update peragus_customer_terms_sessions set active=false, updated_at=now() where id=$1", [prior.id]);
      } else if (prior) {
        if (prior.state === "creating" && Date.parse(prior.leaseUntil) <= now.getTime()) {
          const claimed = await db.query<Row>("update peragus_customer_terms_sessions set generation=generation+1,lease_until=$2,updated_at=now() where id=$1 returning *", [prior.id, lease]);
          await db.query("commit"); return { record: map(claimed.rows[0]!), claimed: true };
        }
        await db.query("commit"); return { record: prior, claimed: false };
      }
      const id = randomUUID();
      const r = await db.query<Row>(`insert into peragus_customer_terms_sessions(id,customer_id,idempotency_key,lease_until)
        values($1,$2,$3,$4) returning *`, [id, customerId, `peragus-terms-${id}`, lease]);
      await db.query("commit"); return { record: map(r.rows[0]!), claimed: true };
    } catch (error) { await db.query("rollback"); if ((error as { code?: string }).code === "23505") throw new TermsFlowError("TERMS_PROCESSING"); throw error; }
    finally { db.release(); }
  }
  async completeCreation(record: TermsRecord, result: { token: TermsEnvelope; url: string; version: string; expiresAt: string }) {
    const r = await this.pool.query<Row>(`update peragus_customer_terms_sessions set state='ready', encrypted_token=$4::jsonb,
      terms_url=$5,terms_version=$6,expires_at=$7,updated_at=now()
      where id=$1 and customer_id=$2 and generation=$3 and state='creating' and active returning *`,
      [record.id, record.customerId, record.generation, JSON.stringify(result.token), result.url, result.version, result.expiresAt]);
    if (!r.rows[0]) throw new TermsFlowError("TERMS_SESSION_CONFLICT"); return map(r.rows[0]);
  }
  async markUncertain(record: TermsRecord) {
    await this.pool.query("update peragus_customer_terms_sessions set state='uncertain',updated_at=now() where id=$1 and customer_id=$2 and generation=$3 and state='creating' and active", [record.id, record.customerId, record.generation]);
  }
  async claimAcceptance(record: TermsRecord, evidence: TermsEnvelope, now: Date) {
    const r = await this.pool.query<Row>(`update peragus_customer_terms_sessions
      set encrypted_acceptance=case when state='ready' then $3::jsonb else encrypted_acceptance end,
        state='accepting',generation=generation+1,lease_until=$5,updated_at=now()
      where id=$1 and customer_id=$2 and active and environment='test' and generation=$6
        and ((state='ready' and expires_at>$4) or (state='accepting' and lease_until<=$4)) returning *`,
      [record.id, record.customerId, JSON.stringify(evidence), now.toISOString(), new Date(now.getTime()+30000).toISOString(), record.generation]);
    if (!r.rows[0]) throw new TermsFlowError("TERMS_PROCESSING"); return map(r.rows[0]);
  }
  async completeAcceptance(record: TermsRecord, acceptedAt: string) {
    const r = await this.pool.query<Row>(`update peragus_customer_terms_sessions set state='accepted',accepted_at=$4,updated_at=now()
      where id=$1 and customer_id=$2 and generation=$3 and state='accepting' and active returning *`,
      [record.id, record.customerId, record.generation, acceptedAt]);
    if (!r.rows[0]) throw new TermsFlowError("TERMS_SESSION_CONFLICT"); return map(r.rows[0]);
  }
}
