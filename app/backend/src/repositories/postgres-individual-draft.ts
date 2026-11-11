import type { Pool } from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import type { EncryptedDraft } from "../onboarding/draft-cipher.js";
export interface StoredIndividualDraft { encrypted: unknown; version: number; updatedAt: string; }
export class DraftVersionConflict extends Error {}
export interface IndividualDraftRepository {
  find(customerId: string): Promise<StoredIndividualDraft | null>;
  save(customerId: string, expectedVersion: number, encrypted: EncryptedDraft): Promise<StoredIndividualDraft>;
}
interface Row { encrypted_payload: unknown; version: number; updated_at: Date | string; }
const map = (row: Row): StoredIndividualDraft => ({ encrypted: row.encrypted_payload, version: row.version, updatedAt: new Date(row.updated_at).toISOString() });
export class PostgresIndividualDraftRepository implements IndividualDraftRepository {
  private readonly e: RowEnvironment;
  constructor(private readonly pool: Pool, mode: MoneyMode) { this.e = rowEnvironment(mode); }
  async find(customerId: string) {
    const r = await this.pool.query<Row>(`select encrypted_payload, version, updated_at from peragus_individual_onboarding_drafts where customer_id=$1 and environment='${this.e.mode}'`, [customerId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }
  async save(customerId: string, expectedVersion: number, encrypted: EncryptedDraft) {
    const r = expectedVersion === 0
      ? await this.pool.query<Row>(`insert into peragus_individual_onboarding_drafts(customer_id,encrypted_payload,environment)
          values($1,$2::jsonb,$3) on conflict(customer_id) do nothing returning *`, [customerId, JSON.stringify(encrypted), this.e.mode])
      : await this.pool.query<Row>(`update peragus_individual_onboarding_drafts
          set encrypted_payload=$3::jsonb, version=version+1, updated_at=now()
          where customer_id=$1 and environment='${this.e.mode}' and version=$2 returning *`, [customerId, expectedVersion, JSON.stringify(encrypted)]);
    if (!r.rows[0]) throw new DraftVersionConflict();
    return map(r.rows[0]);
  }
}
