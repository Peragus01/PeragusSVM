import { describe, expect, it } from "vitest";
import {
  ReconcileOzavOnrampService,
  type OzavImportResult,
} from "../src/application/reconcile-ozav-onramp.js";
import { OzavPersistenceError, type OzavOnrampBinding } from "../src/domain/ozav-onramp.js";
import type { Settlement, SettlementStatus } from "../src/domain/settlement.js";

const settlementId = "00000000-0000-4000-8000-000000000001";
const binding: OzavOnrampBinding = {
  settlementId,
  transferId: "ozav_tr_test",
  customerId: "ozav_cus_test",
  walletId: "ozav_wal_test",
  quoteId: "ozav_q_test",
};

function importResult(
  status: string,
  sourceLeg: string | null = "completed",
  destinationLeg: string | null = "completed",
): OzavImportResult {
  return {
    currentTransferStatus: status,
    currentSourceLegStatus: sourceLeg,
    currentDestinationLegStatus: destinationLeg,
    eventIds: ["ozav_evt_1", "ozav_evt_2"],
    eventsFound: 2,
    inserted: 2,
    duplicates: 0,
  };
}

function setup(
  initialStatus: SettlementStatus = "created",
  provider = importResult("completed"),
) {
  let settlement = {
    id: settlementId,
    status: initialStatus,
    version: 0,
  } as Settlement;
  let linked: OzavOnrampBinding | null = binding;
  let imported = 0;
  const processed = new Set<string>();
  const marked: string[][] = [];
  const transitions: SettlementStatus[] = [];
  let transitionError: Error | null = null;
  const service = new ReconcileOzavOnrampService({
    importer: {
      async execute() {
        imported += 1;
        return provider;
      },
    },
    ozavRepository: {
      async findBinding() {
        return linked;
      },
      async markEventsProcessed(id, eventIds) {
        expect(id).toBe(settlementId);
        marked.push(eventIds);
        let count = 0;
        for (const eventId of eventIds) {
          if (!processed.has(eventId)) {
            processed.add(eventId);
            count += 1;
          }
        }
        return count;
      },
    },
    settlements: {
      async findById() {
        return settlement;
      },
    },
    transitioner: {
      async execute({ nextStatus }) {
        if (transitionError) throw transitionError;
        transitions.push(nextStatus);
        settlement = {
          ...settlement,
          status: nextStatus,
          version: settlement.version + 1,
        };
        return settlement;
      },
    },
    now: () => new Date("2026-10-07T12:00:00Z"),
  });
  return {
    service,
    transitions,
    marked,
    processed,
    imported: () => imported,
    settlement: () => settlement,
    unlink: () => { linked = null; },
    failTransition: (error: Error) => { transitionError = error; },
  };
}

describe("OZAV on-ramp reconciliation", () => {
  it("does nothing until the settlement has an OZAV binding", async () => {
    const s = setup();
    s.unlink();
    expect(await s.service.execute(settlementId)).toMatchObject({
      providerLinked: false,
      settlementStatus: "created",
      eventsProcessed: 0,
    });
    expect(s.imported()).toBe(0);
  });

  it("advances a completed on-ramp through every allowed status", async () => {
    const s = setup();
    expect(await s.service.execute(settlementId)).toMatchObject({
      providerStatus: "completed",
      settlementStatus: "tokenized",
      transitions: ["awaiting_pix", "pix_confirmed", "tokenized"],
      eventsProcessed: 2,
    });
    expect(s.settlement().version).toBe(3);
    expect(s.marked).toEqual([["ozav_evt_1", "ozav_evt_2"]]);
  });

  it("is idempotent after reaching tokenized", async () => {
    const s = setup("tokenized");
    expect(await s.service.execute(settlementId)).toMatchObject({
      transitions: [],
      settlementStatus: "tokenized",
      eventsProcessed: 2,
    });
    expect(await s.service.execute(settlementId)).toMatchObject({
      transitions: [],
      eventsProcessed: 0,
    });
    expect(s.settlement().version).toBe(0);
  });

  it("stops at pix_confirmed while conversion is still in progress", async () => {
    const s = setup("created", importResult("converting", "completed", "pending"));
    expect(await s.service.execute(settlementId)).toMatchObject({
      settlementStatus: "pix_confirmed",
      transitions: ["awaiting_pix", "pix_confirmed"],
    });
  });

  it("requires a completed source leg after payment confirmation", async () => {
    const s = setup("awaiting_pix", importResult("payment_confirmed", "pending", "pending"));
    await expect(s.service.execute(settlementId)).rejects.toThrow("source leg");
    expect(s.marked).toHaveLength(0);
  });

  it("requires both completed legs before tokenization", async () => {
    const s = setup("pix_confirmed", importResult("completed", "completed", "pending"));
    await expect(s.service.execute(settlementId)).rejects.toThrow("incomplete settlement leg");
    expect(s.settlement().status).toBe("pix_confirmed");
    expect(s.marked).toHaveLength(0);
  });

  it("moves an early terminal provider failure to failed", async () => {
    const s = setup("awaiting_pix", importResult("expired", "pending", "pending"));
    expect(await s.service.execute(settlementId)).toMatchObject({
      settlementStatus: "failed",
      transitions: ["failed"],
    });
  });

  it("rejects a provider failure that contradicts an advanced settlement", async () => {
    const s = setup("tokenized", importResult("failed", "completed", "pending"));
    await expect(s.service.execute(settlementId)).rejects.toThrow("advanced settlement");
    expect(s.marked).toHaveLength(0);
  });

  it("records needs_review as processed attention without changing status", async () => {
    const s = setup("awaiting_pix", importResult("needs_review", "completed", "pending"));
    expect(await s.service.execute(settlementId)).toMatchObject({
      attentionRequired: true,
      settlementStatus: "awaiting_pix",
      transitions: [],
      eventsProcessed: 2,
    });
  });

  it("rejects unknown provider states without acknowledging events", async () => {
    const s = setup("created", importResult("future_state"));
    await expect(s.service.execute(settlementId)).rejects.toThrow("Unsupported OZAV transfer status");
    expect(s.marked).toHaveLength(0);
  });

  it("does not acknowledge events when a transition fails", async () => {
    const s = setup();
    s.failTransition(new Error("concurrent update"));
    await expect(s.service.execute(settlementId)).rejects.toThrow("concurrent update");
    expect(s.marked).toHaveLength(0);
  });

  it("does not move a post-tokenization settlement backwards", async () => {
    const s = setup("settling", importResult("completed"));
    expect(await s.service.execute(settlementId)).toMatchObject({
      settlementStatus: "settling",
      transitions: [],
      eventsProcessed: 2,
    });
  });

  it("surfaces a missing settlement", async () => {
    const s = setup();
    const missing = new ReconcileOzavOnrampService({
      importer: { execute: async () => importResult("completed") },
      ozavRepository: {
        findBinding: async () => binding,
        markEventsProcessed: async () => 0,
      },
      settlements: { findById: async () => null },
      transitioner: { execute: async () => { throw new Error("unreachable"); } },
    });
    await expect(missing.execute(settlementId)).rejects.toBeInstanceOf(OzavPersistenceError);
    expect(s.imported()).toBe(0);
  });
});
