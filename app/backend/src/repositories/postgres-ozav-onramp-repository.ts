import type { Pool } from "pg";
import {
  normalizeOzavBinding, normalizeOzavEvent, OzavPersistenceError, sameOzavBinding,
  type OzavOnrampBinding, type OzavStoredEvent,
} from "../domain/ozav-onramp.js";
import type { OzavEvent } from "../providers/ozav-client.js";
import type { OzavOnrampRepository } from "./ozav-onramp-repository.js";

interface BindingRow {
  settlement_id: string; transfer_id: string; customer_id: string;
  wallet_id: string; quote_id: string;
}

const columns = "settlement_id, transfer_id, customer_id, wallet_id, quote_id";
function mapBinding(row: BindingRow): OzavOnrampBinding {
  return { settlementId: row.settlement_id, transferId: row.transfer_id,
    customerId: row.customer_id, walletId: row.wallet_id, quoteId: row.quote_id };
}

export class PostgresOzavOnrampRepository implements OzavOnrampRepository {
  private readonly database: Pick<Pool, "query">;
  constructor(database: Pick<Pool, "query">) { this.database = database; }

  async createBinding(input: OzavOnrampBinding): Promise<{ binding: OzavOnrampBinding; created: boolean }> {
    const binding = normalizeOzavBinding(input);
    try {
      const inserted = await this.database.query<BindingRow>(`
        insert into settlement_ozav_onramps (${columns}) values ($1, $2, $3, $4, $5)
        on conflict (settlement_id) do nothing returning ${columns}
      `, [binding.settlementId, binding.transferId, binding.customerId, binding.walletId, binding.quoteId]);
      const row = inserted.rows[0];
      if (row) return { binding: mapBinding(row), created: true };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new OzavPersistenceError("OZAV transfer is already linked to another settlement");
      }
      throw error;
    }
    const existing = await this.findBinding(binding.settlementId);
    if (!existing || !sameOzavBinding(existing, binding)) {
      throw new OzavPersistenceError("Settlement already has a different OZAV binding");
    }
    return { binding: existing, created: false };
  }

  async findBinding(settlementId: string): Promise<OzavOnrampBinding | null> {
    const result = await this.database.query<BindingRow>(`
      select ${columns} from settlement_ozav_onramps where settlement_id = $1
    `, [settlementId]);
    return result.rows[0] ? mapBinding(result.rows[0]) : null;
  }

  async recordEvent(input: OzavOnrampBinding, event: OzavEvent): Promise<{ inserted: boolean }> {
    const binding = normalizeOzavBinding(input);
    const record = normalizeOzavEvent(binding, event);
    const inserted = await this.database.query(`
      insert into settlement_ozav_events (
        event_id, settlement_id, transfer_id, event_type, occurred_at, content_hash, snapshot
      )
      select $1::varchar(128), settlement_id, transfer_id, $4::varchar(128),
        $5::timestamptz, $6::char(64), $7::jsonb
      from settlement_ozav_onramps
      where settlement_id = $2 and transfer_id = $3
        and customer_id = $8 and wallet_id = $9 and quote_id = $10
      on conflict (event_id) do nothing returning event_id
    `, [record.eventId, binding.settlementId, binding.transferId, record.eventType,
      record.occurredAt, record.contentHash, record.snapshot,
      binding.customerId, binding.walletId, binding.quoteId]);
    if (inserted.rowCount === 1) return { inserted: true };
    const existing = await this.database.query<{ content_hash: string }>(`
      select e.content_hash from settlement_ozav_events e
      join settlement_ozav_onramps b on b.settlement_id = e.settlement_id
        and b.transfer_id = e.transfer_id
      where e.event_id = $1 and b.settlement_id = $2 and b.transfer_id = $3
        and b.customer_id = $4 and b.wallet_id = $5 and b.quote_id = $6
    `, [record.eventId, binding.settlementId, binding.transferId,
      binding.customerId, binding.walletId, binding.quoteId]);
    if (existing.rows[0]?.content_hash !== record.contentHash) {
      throw new OzavPersistenceError("OZAV event conflict or missing matching binding");
    }
    return { inserted: false };
  }

  async listEvents(settlementId: string): Promise<OzavStoredEvent[]> {
    const result = await this.database.query<{
      event_id: string; settlement_id: string; transfer_id: string; event_type: string;
      occurred_at: Date; content_hash: string; snapshot: OzavStoredEvent["snapshot"];
    }>(`
      select event_id, settlement_id, transfer_id, event_type, occurred_at, content_hash, snapshot
      from settlement_ozav_events where settlement_id = $1 order by occurred_at, event_id
    `, [settlementId]);
    return result.rows.map((row) => ({ eventId: row.event_id, settlementId: row.settlement_id,
      transferId: row.transfer_id, eventType: row.event_type, occurredAt: row.occurred_at.toISOString(),
      contentHash: row.content_hash, snapshot: row.snapshot }));
  }
}
