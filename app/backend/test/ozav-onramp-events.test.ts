import { describe, expect, it } from "vitest";
import { ImportOzavOnrampEventsService } from "../src/application/import-ozav-onramp-events.js";
import {
  normalizeOzavBinding, normalizeOzavEvent, OzavPersistenceError, sameOzavBinding,
  type OzavOnrampBinding, type OzavStoredEvent,
} from "../src/domain/ozav-onramp.js";
import type { OzavEvent, OzavEventPage, OzavTransfer } from "../src/providers/ozav-client.js";
import type { OzavOnrampRepository } from "../src/repositories/ozav-onramp-repository.js";
import type { Settlement } from "../src/domain/settlement.js";

const binding: OzavOnrampBinding = {
  settlementId: "00000000-0000-4000-8000-000000000001",
  transferId: "ozav_tr_test", customerId: "ozav_cus_test",
  walletId: "ozav_wal_test", quoteId: "ozav_q_test",
};
const transfer: OzavTransfer = {
  id: binding.transferId, status: "completed", customerId: binding.customerId, quoteId: binding.quoteId,
  source: { type: "fiat_payment", currency: "BRL", rail: "pix" },
  destination: { type: "wallet", walletId: binding.walletId },
  sourceLegStatus: "completed", destinationLegStatus: "completed",
  amounts: { source: { amount: "500", currency: "BRL" }, target: { amount: "89.55", currency: "USDT" } },
};
function event(id: string, hour: number, status: string): OzavEvent {
  return { id, type: status === "completed" ? "transfer.completed" : "transfer.updated",
    createdAt: `2026-10-07T${hour}:00:00Z`, transfer: { ...structuredClone(transfer), status } };
}
const oldest = event("ozav_evt_old", 10, "awaiting_payment");
const middle = event("ozav_evt_mid", 11, "payment_confirmed");
const newest = event("ozav_evt_new", 12, "completed");

class MemoryRepository implements OzavOnrampRepository {
  readonly bindings = new Map<string, OzavOnrampBinding>();
  readonly records = new Map<string, OzavStoredEvent>();
  readonly insertionOrder: string[] = [];
  async createBinding(input: OzavOnrampBinding) {
    const normalized = normalizeOzavBinding(input);
    const existing = this.bindings.get(normalized.settlementId);
    if (existing && !sameOzavBinding(existing, normalized)) throw new OzavPersistenceError("different OZAV binding");
    if ([...this.bindings.values()].some((row) => row.transferId === normalized.transferId
      && row.settlementId !== normalized.settlementId)) throw new OzavPersistenceError("already linked");
    if (!existing) this.bindings.set(normalized.settlementId, normalized);
    return { binding: existing ?? normalized, created: !existing };
  }
  async findBinding(id: string) { return this.bindings.get(id) ?? null; }
  async recordEvent(input: OzavOnrampBinding, value: OzavEvent) {
    const stored = normalizeOzavEvent(input, value);
    const existing = this.records.get(stored.eventId);
    if (existing && existing.contentHash !== stored.contentHash) throw new OzavPersistenceError("event conflict");
    if (!existing) {
      this.records.set(stored.eventId, stored);
      this.insertionOrder.push(stored.eventId);
    }
    return { inserted: !existing };
  }
  async listEvents(id: string) { return [...this.records.values()].filter((row) => row.settlementId === id); }
}

function setup() {
  const repository = new MemoryRepository();
  const pages: Record<string, OzavEventPage> = {
    first: { data: [newest, middle], hasMore: true, nextCursor: "older" },
    older: { data: [oldest], hasMore: false, nextCursor: null },
  };
  const calls: string[] = [];
  let current = structuredClone(transfer);
  let scopes = ["transfers:read", "events:read"];
  let exists = true;
  const settlement = { id: binding.settlementId, status: "created", version: 0 } as Settlement;
  const client = {
    async getCapabilities() { calls.push("capabilities"); return { environment: "test" as const, scopes }; },
    async getTransfer() { calls.push("transfer"); return current; },
    async listEvents(cursor?: string) {
      calls.push(cursor ?? "first");
      const page = pages[cursor ?? "first"];
      if (!page) throw new Error("Unknown cursor");
      return page;
    },
  };
  return { repository, pages, calls, settlement, client,
    setCurrent: (value: OzavTransfer) => { current = value; },
    setScopes: (value: string[]) => { scopes = value; },
    setExists: (value: boolean) => { exists = value; },
    service: new ImportOzavOnrampEventsService({ client, repository,
      settlements: { findById: async () => exists ? settlement : null } }),
  };
}

describe("OZAV event import", () => {
  it("reads every page, then current transfer, and inserts in chronological order", async () => {
    const s = setup();
    const result = await s.service.execute(binding);
    expect(result).toMatchObject({ bindingCreated: true, eventsFound: 3, inserted: 3, duplicates: 0, currentTransferStatus: "completed" });
    expect(s.calls).toEqual(["capabilities", "first", "older", "transfer"]);
    expect(s.repository.insertionOrder).toEqual([oldest.id, middle.id, newest.id]);
    expect(s.settlement.status).toBe("created");
    expect(s.settlement.version).toBe(0);
  });
  it("deduplicates a repeated import", async () => {
    const s = setup();
    await s.service.execute(binding);
    expect(await s.service.execute(binding)).toMatchObject({ bindingCreated: false, inserted: 0, duplicates: 3 });
    expect(s.repository.records.size).toBe(3);
  });
  it("deduplicates overlapping pages", async () => {
    const s = setup();
    s.pages.older = { data: [middle, oldest], hasMore: false, nextCursor: null };
    expect(await s.service.execute(binding)).toMatchObject({ eventsFound: 4, inserted: 3, duplicates: 1 });
  });
  it("rejects changed financial content under an existing event ID", async () => {
    const s = setup();
    await s.service.execute(binding);
    const altered = structuredClone(oldest);
    altered.transfer!.amounts.target.amount = "1.00";
    s.pages.older = { data: [altered], hasMore: false, nextCursor: null };
    await expect(s.service.execute(binding)).rejects.toThrow("event conflict");
    expect(s.repository.records.size).toBe(3);
  });
  it("rejects a different customer in historical events before writing", async () => {
    const s = setup();
    const altered = structuredClone(oldest);
    altered.transfer!.customerId = "ozav_cus_other";
    s.pages.older = { data: [altered], hasMore: false, nextCursor: null };
    await expect(s.service.execute(binding)).rejects.toThrow("does not match");
    expect(s.repository.bindings.size).toBe(0);
    expect(s.repository.records.size).toBe(0);
  });
  it("rejects a different wallet in the current transfer before writing", async () => {
    const s = setup();
    const altered = structuredClone(transfer);
    altered.destination.walletId = "ozav_wal_other";
    s.setCurrent(altered);
    await expect(s.service.execute(binding)).rejects.toThrow("does not match");
    expect(s.repository.bindings.size).toBe(0);
  });
  it("rejects an off-ramp or wrong asset", async () => {
    const s = setup();
    const altered = structuredClone(transfer);
    altered.amounts.target.currency = "USD";
    s.setCurrent(altered);
    await expect(s.service.execute(binding)).rejects.toThrow("does not match");
  });
  it("refuses missing settlements before calling the provider", async () => {
    const s = setup();
    s.setExists(false);
    await expect(s.service.execute(binding)).rejects.toThrow("Settlement not found");
    expect(s.calls).toHaveLength(0);
  });
  it("requires read scopes before fetching events", async () => {
    const s = setup();
    s.setScopes(["transfers:read"]);
    await expect(s.service.execute(binding)).rejects.toThrow("read scopes");
    expect(s.calls).toEqual(["capabilities"]);
  });
  it("ignores unrelated transfers and other event types", async () => {
    const s = setup();
    const unrelated = structuredClone(newest);
    unrelated.transfer!.id = "ozav_tr_other";
    s.pages.first = { data: [unrelated, { id: "ozav_evt_customer", type: "customer.updated",
      createdAt: newest.createdAt, transfer: null }], hasMore: false, nextCursor: null };
    expect(await s.service.execute(binding)).toMatchObject({ inserted: 0, eventsFound: 0 });
    expect(s.settlement.status).toBe("created");
  });
  it("refuses repeated cursors without importing partial history", async () => {
    const s = setup();
    s.pages.older = { data: [oldest], hasMore: true, nextCursor: "older" };
    await expect(s.service.execute(binding)).rejects.toThrow("repeated OZAV event cursor");
    expect(s.repository.bindings.size).toBe(0);
  });
  it("refuses scans over 10 pages without writing partial history", async () => {
    const s = setup();
    s.pages.first = { data: [newest], hasMore: true, nextCursor: "page1" };
    for (let n = 1; n <= 10; n += 1) s.pages[`page${n}`] = { data: [], hasMore: true, nextCursor: `page${n + 1}` };
    await expect(s.service.execute(binding)).rejects.toThrow("exceeded 10 pages");
    expect(s.repository.records.size).toBe(0);
  });
  it("does not replace an existing binding", async () => {
    const s = setup();
    await s.service.execute(binding);
    await expect(s.repository.createBinding({ ...binding, quoteId: "ozav_q_other" })).rejects.toThrow("different OZAV binding");
  });
  it("does not reuse a transfer for another settlement", async () => {
    const s = setup();
    await s.service.execute(binding);
    await expect(s.repository.createBinding({ ...binding, settlementId: "00000000-0000-4000-8000-000000000002" }))
      .rejects.toThrow("already linked");
  });
  it("canonicalizes decimal amounts and timestamps for replay comparison", () => {
    const equivalent = structuredClone(newest);
    equivalent.createdAt = "2026-10-07T12:00:00.000+00:00";
    equivalent.transfer!.amounts.source.amount = "000500.000000";
    equivalent.transfer!.amounts.target.amount = "89.550000";
    expect(normalizeOzavEvent(binding, equivalent).contentHash).toBe(normalizeOzavEvent(binding, newest).contentHash);
  });
  it("retains precision beyond safe JavaScript integers", () => {
    const large = structuredClone(newest);
    large.transfer!.amounts.source.amount = "9007199254740993.123456";
    expect(normalizeOzavEvent(binding, large).snapshot.sourceAmountBrl).toBe("9007199254740993.123456");
  });
});
