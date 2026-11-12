import type { Pool } from "pg";
import type { MoneyMode } from "../config/money-environment.js";
import type {
  LegalAcceptanceRepository,
  LegalDocument,
  LegalEvidence,
  RequiredLegalDocument,
} from "../legal/legal-acceptance.js";
import { rowEnvironment, type RowEnvironment } from "./row-environment.js";

export class PostgresLegalAcceptanceRepository
  implements LegalAcceptanceRepository
{
  private readonly e: RowEnvironment;
  constructor(
    private readonly pool: Pool,
    mode: MoneyMode,
  ) {
    this.e = rowEnvironment(mode);
  }
  async listAccepted(customerId: string): Promise<RequiredLegalDocument[]> {
    const r = await this.pool.query<{
      document: LegalDocument;
      version: string;
      sha256: string;
    }>(
      `select document,version,sha256 from peragus_customer_legal_acceptances
       where customer_id=$1 and environment='${this.e.mode}'`,
      [customerId],
    );
    return r.rows;
  }
  async record(
    evidence: LegalEvidence,
    documents: RequiredLegalDocument[],
  ): Promise<void> {
    if (!documents.length) return;
    // One statement: all documents are recorded or none.
    await this.pool.query(
      `insert into peragus_customer_legal_acceptances(user_id,customer_id,document,version,sha256,ip,user_agent,environment)
       select $1,$2,d.document,d.version,d.sha256,$6::inet,$7,'${this.e.mode}'
       from unnest($3::text[],$4::text[],$5::text[]) as d(document,version,sha256)
       on conflict(customer_id,document,version,sha256,environment) do nothing`,
      [
        evidence.userId,
        evidence.customerId,
        documents.map((d) => d.document),
        documents.map((d) => d.version),
        documents.map((d) => d.sha256),
        evidence.ip,
        evidence.userAgent,
      ],
    );
  }
}
