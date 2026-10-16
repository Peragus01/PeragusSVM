import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PostgresCustomerRepository } from "../src/repositories/postgres-customer-repository.js";
import { PostgresSettlementRepository } from "../src/repositories/postgres-settlement-repository.js";
import { CreateSettlementService } from "../src/application/create-settlement.js";
const db = new PGlite();
// PgBoss/Railway networking is covered separately; this exercises actual PostgreSQL SQL semantics.
const pool = { query: async (text: string, values?: unknown[]) => {
  const result = await db.query(text, values);
  return { ...result, rowCount: result.rows.length };
} } as unknown as Pool;
const customers = new PostgresCustomerRepository(pool);
const settlements = new PostgresSettlementRepository(pool);
let legacyId: string;
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; alter default privileges grant all on tables to anon, authenticated;");
  const dir = new URL("../migrations/", import.meta.url);
  const files = (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  for (const file of files.filter(f => !f.startsWith("010_"))) await db.exec(await readFile(new URL(file, dir), "utf8"));
  const legacy = await new CreateSettlementService(settlements).execute({ requestId: randomUUID(), corridorId: "ab".repeat(32), payerWallet: "11111111111111111111111111111112", recipientWallet: "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR", sourceAmount: "1", destinationAmount: "1", expiresAt: "2099-01-01T00:00:00Z" });
  legacyId = legacy.settlement.id;
  await db.exec(await readFile(new URL("010_add_customer_access.sql", dir), "utf8"));
}, 30000);
afterAll(async () => { await db.close(); });
describe("customer migration and PostgreSQL repository", () => {
  it("preserves existing settlements without assigning a customer", async () => {
    expect(await settlements.findById(legacyId)).not.toBeNull();
    const result = await db.query<{ customer_id: string | null }>("select customer_id from settlements where id=$1", [legacyId]);
    expect(result.rows[0]?.customer_id).toBeNull();
  });
  it("creates PF/PJ profiles once, looks up by owner and isolates settlement ownership", async () => {
    const a = randomUUID(), b = randomUUID();
    const input = { ownerUserId: a, type: "pf" as const, displayName: "Alice" };
    const first = await customers.createOrGet(input);
    const replay = await customers.createOrGet(input);
    const other = await customers.createOrGet({ ownerUserId: b, type: "pj", displayName: "Bob Ltd" });
    expect(first.created).toBe(true); expect(replay.created).toBe(false);
    expect(replay.customer.id).toBe(first.customer.id);
    expect((await customers.findByOwner(a))?.verificationStatus).toBe("draft");
    expect(await customers.findByOwner(randomUUID())).toBeNull();
    expect(await customers.ownsSettlement(first.customer.id, legacyId)).toBe(false);
    await db.query("update settlements set customer_id=$1 where id=$2", [first.customer.id, legacyId]);
    expect(await customers.ownsSettlement(first.customer.id, legacyId)).toBe(true);
    expect(await customers.ownsSettlement(other.customer.id, legacyId)).toBe(false);
    expect(await customers.ownsSettlement(first.customer.id, randomUUID())).toBe(false);
  });
  it("enforces valid profile types, status and unique owners at the database", async () => {
    await expect(db.query("insert into peragus_customers(id,owner_user_id,customer_type,display_name) values($1,$2,'admin','Bad')", [randomUUID(), randomUUID()])).rejects.toThrow();
    await expect(db.query("insert into peragus_customers(id,owner_user_id,customer_type,display_name,verification_status) values($1,$2,'pf','Bad','bypassed')", [randomUUID(), randomUUID()])).rejects.toThrow();
    const user = randomUUID();
    await customers.createOrGet({ ownerUserId: user, type: "pf", displayName: "Owner" });
    await expect(db.query("insert into peragus_customers(id,owner_user_id,customer_type,display_name) values($1,$2,'pf','Duplicate')", [randomUUID(), user])).rejects.toThrow();
  });
  it("enables RLS and revokes inherited browser-role permissions", async () => {
    const result = await db.query<{ relrowsecurity: boolean; anon_select: boolean; authenticated_insert: boolean }>(`select relrowsecurity,
      has_table_privilege('anon','peragus_customers','SELECT') as anon_select,
      has_table_privilege('authenticated','peragus_customers','INSERT') as authenticated_insert
      from pg_class where relname='peragus_customers'`);
    expect(result.rows[0]).toEqual({ relrowsecurity: true, anon_select: false, authenticated_insert: false });
  });
});
