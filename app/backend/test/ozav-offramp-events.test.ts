import { describe, expect, it } from "vitest";

import { ImportOzavOfframpEventsService } from "../src/application/import-ozav-offramp-events.js";
import {
  normalizeOzavOfframpEvent,
  type OzavOfframpIntent,
  type OzavOfframpStoredEvent,
} from "../src/domain/ozav-offramp-intent.js";
import type { Settlement } from "../src/domain/settlement.js";
import type {
  OzavEvent,
  OzavEventPage,
  OzavTransfer,
} from "../src/providers/ozav-client.js";
import type {
  OzavOfframpReconciliationRepository,
  UpdateOzavOfframpTransferInput,
} from "../src/repositories/ozav-offramp-reconciliation-repository.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

const intent: OzavOfframpIntent = {
  settlementId,
  customerId: "ozav_cus_test",
  walletId: "ozav_wal_test",
  payoutDestinationId: "ozav_pd_test",
  sourceAmountUsdt: "89.55",
  spreadBps: 0,
  idempotencyKey:
    "peragus_offramp_00000000000040008000000000000001",
  quoteId: "ozav_q_offramp",
  quoteTargetAmountBrl: "500",
  transferId: "ozav_tr_offramp",
  providerStatus: "converting",
  transferSourceAmountUsdt: "89.55",
  transferTargetAmountBrl: "499.98",
  createdAt: new Date("2026-10-10T12:00:00Z"),
  updatedAt: new Date("2026-10-10T12:01:00Z"),
};

const transfer: OzavTransfer = {
  id: "ozav_tr_offramp",
  status: "completed",
  customerId: "ozav_cus_test",
  quoteId: "ozav_q_offramp",
  source: {
    type: "wallet",
    currency: "USDT",
    rail: null,
    walletId: "ozav_wal_test",
  },
  destination: {
    type: "payout_destination",
    walletId: null,
    payoutDestinationId: "ozav_pd_test",
  },
  sourceLegStatus: "completed",
  destinationLegStatus: "completed",
  amounts: {
    source: { amount: "89.55", currency: "USDT" },
    target: { amount: "499.98", currency: "BRL" },
  },
};

function event(
  id: string,
  hour: number,
  status: string,
): OzavEvent {
  return {
    id,
    type: status === "completed"
      ? "transfer.completed"
      : "transfer.updated",
    createdAt: `2026-10-10T${hour}:00:00Z`,
    transfer: {
      ...structuredClone(transfer),
      status,
    },
  };
}

const oldest = event(
  "ozav_evt_offramp_old",
  10,
  "converting",
);
const middle = event(
  "ozav_evt_offramp_mid",
  11,
  "payout_initiated",
);
const newest = event(
  "ozav_evt_offramp_new",
  12,
  "completed",
);

class MemoryRepository
  implements OzavOfframpReconciliationRepository
{
  storedIntent: OzavOfframpIntent | null = {
    ...intent,
  };
  readonly records = new Map<
    string,
    OzavOfframpStoredEvent
  >();
  readonly insertionOrder: string[] = [];
  readonly processed = new Set<string>();

  async find() {
    return this.storedIntent;
  }

  async updateTransferState(
    input: UpdateOzavOfframpTransferInput,
  ) {
    if (!this.storedIntent) {
      throw new Error("missing intent");
    }
    this.storedIntent = {
      ...this.storedIntent,
      providerStatus: input.providerStatus,
      transferSourceAmountUsdt: input.sourceAmountUsdt,
      transferTargetAmountBrl: input.targetAmountBrl,
      updatedAt: input.updatedAt,
    };
    return this.storedIntent;
  }

  async recordEvent(
    valueIntent: OzavOfframpIntent,
    value: OzavEvent,
  ) {
    const stored = normalizeOzavOfframpEvent(
      valueIntent,
      value,
    );
    const existing = this.records.get(stored.eventId);

    if (
      existing
      && existing.contentHash !== stored.contentHash
    ) {
      throw new Error("off-ramp event conflict");
    }
    if (!existing) {
      this.records.set(stored.eventId, stored);
      this.insertionOrder.push(stored.eventId);
    }
    return { inserted: !existing };
  }

  async listEvents() {
    return [...this.records.values()];
  }

  async markEventsProcessed(
    id: string,
    eventIds: string[],
  ) {
    let count = 0;
    for (const eventId of eventIds) {
      if (
        this.records.get(eventId)?.settlementId === id
        && !this.processed.has(eventId)
      ) {
        this.processed.add(eventId);
        count += 1;
      }
    }
    return count;
  }
}

function setup() {
  const repository = new MemoryRepository();
  const pages: Record<string, OzavEventPage> = {
    first: {
      data: [newest, middle],
      hasMore: true,
      nextCursor: "older",
    },
    older: {
      data: [oldest],
      hasMore: false,
      nextCursor: null,
    },
  };
  const calls: string[] = [];
  let current = structuredClone(transfer);
  let scopes = ["transfers:read", "events:read"];
  let exists = true;
  const settlement = {
    id: settlementId,
    status: "offramping",
  } as Settlement;
  const client = {
    async getCapabilities() {
      calls.push("capabilities");
      return {
        environment: "test" as const,
        scopes,
      };
    },
    async getTransfer() {
      calls.push("transfer");
      return current;
    },
    async listEvents(cursor?: string) {
      calls.push(cursor ?? "first");
      const page = pages[cursor ?? "first"];
      if (!page) throw new Error("Unknown cursor");
      return page;
    },
  };

  return {
    repository,
    pages,
    calls,
    setCurrent: (value: OzavTransfer) => {
      current = value;
    },
    setScopes: (value: string[]) => {
      scopes = value;
    },
    setExists: (value: boolean) => {
      exists = value;
    },
    service: new ImportOzavOfframpEventsService({
      client,
      repository,
      settlements: {
        findById: async () => exists ? settlement : null,
      },
      now: () => new Date("2026-10-10T12:30:00Z"),
    }),
  };
}

describe("OZAV off-ramp event import", () => {
  it("imports every page and refreshes the current transfer", async () => {
    const subject = setup();
    const result = await subject.service.execute(intent);

    expect(result).toMatchObject({
      currentTransferStatus: "completed",
      eventsFound: 3,
      inserted: 3,
      duplicates: 0,
    });
    expect(subject.calls).toEqual([
      "capabilities",
      "first",
      "older",
      "transfer",
    ]);
    expect(subject.repository.insertionOrder).toEqual([
      oldest.id,
      middle.id,
      newest.id,
    ]);
    expect(subject.repository.storedIntent).toMatchObject({
      providerStatus: "completed",
      transferTargetAmountBrl: "499.98",
    });
  });

  it("deduplicates repeated and overlapping events", async () => {
    const subject = setup();
    subject.pages.older = {
      data: [middle, oldest],
      hasMore: false,
      nextCursor: null,
    };

    expect(await subject.service.execute(intent)).toMatchObject({
      eventsFound: 4,
      inserted: 3,
      duplicates: 1,
    });
    expect(await subject.service.execute(intent)).toMatchObject({
      inserted: 0,
      duplicates: 4,
    });
  });

  it("rejects a changed event under the same id", async () => {
    const subject = setup();
    await subject.service.execute(intent);
    const altered = structuredClone(oldest);
    altered.transfer!.amounts.target.amount = "450.00";
    subject.pages.older = {
      data: [altered],
      hasMore: false,
      nextCursor: null,
    };

    await expect(subject.service.execute(intent))
      .rejects.toThrow("event conflict");
  });

  it("rejects the wrong payout destination before writing", async () => {
    const subject = setup();
    const altered = structuredClone(oldest);
    altered.transfer!.destination.payoutDestinationId =
      "ozav_pd_other";
    subject.pages.older = {
      data: [altered],
      hasMore: false,
      nextCursor: null,
    };

    await expect(subject.service.execute(intent))
      .rejects.toThrow("does not match");
    expect(subject.repository.records.size).toBe(0);
  });

  it("rejects a changed current source amount", async () => {
    const subject = setup();
    const altered = structuredClone(transfer);
    altered.amounts.source.amount = "88.55";
    subject.setCurrent(altered);

    await expect(subject.service.execute(intent))
      .rejects.toThrow("does not match");
  });

  it("requires the settlement and read scopes", async () => {
    const missing = setup();
    missing.setExists(false);
    await expect(missing.service.execute(intent))
      .rejects.toThrow("settlement data");
    expect(missing.calls).toEqual([]);

    const scopes = setup();
    scopes.setScopes(["transfers:read"]);
    await expect(scopes.service.execute(intent))
      .rejects.toThrow("read scopes");
    expect(scopes.calls).toEqual(["capabilities"]);
  });

  it("refuses repeated cursors without partial writes", async () => {
    const subject = setup();
    subject.pages.older = {
      data: [oldest],
      hasMore: true,
      nextCursor: "older",
    };

    await expect(subject.service.execute(intent))
      .rejects.toThrow("repeated OZAV off-ramp event cursor");
    expect(subject.repository.records.size).toBe(0);
  });

  it("canonicalizes amounts and timestamps for replay", () => {
    const equivalent = structuredClone(newest);
    equivalent.createdAt =
      "2026-10-10T12:00:00.000+00:00";
    equivalent.transfer!.amounts.source.amount =
      "000089.550000";
    equivalent.transfer!.amounts.target.amount =
      "000499.980000";

    expect(
      normalizeOzavOfframpEvent(
        intent,
        equivalent,
      ).contentHash,
    ).toBe(
      normalizeOzavOfframpEvent(
        intent,
        newest,
      ).contentHash,
    );
  });
});
