import { describe, expect, it } from "vitest";

import type { OzavOfframpImportResult } from "../src/application/import-ozav-offramp-events.js";
import { ReconcileOzavOfframpService } from "../src/application/reconcile-ozav-offramp.js";
import type {
  OzavOfframpIntent,
  OzavTransferStatus,
} from "../src/domain/ozav-offramp-intent.js";
import type {
  Settlement,
  SettlementStatus,
} from "../src/domain/settlement.js";

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

function imported(
  status: OzavTransferStatus,
  sourceLeg: string | null = "completed",
  destinationLeg: string | null = "completed",
): OzavOfframpImportResult {
  return {
    currentTransferStatus: status,
    currentSourceLegStatus: sourceLeg,
    currentDestinationLegStatus: destinationLeg,
    currentSourceAmountUsdt: "89.55",
    currentTargetAmountBrl: "499.98",
    eventIds: [
      "ozav_evt_offramp_1",
      "ozav_evt_offramp_2",
    ],
    eventsFound: 2,
    inserted: 2,
    duplicates: 0,
  };
}

function setup(
  initialStatus: SettlementStatus = "offramping",
  provider = imported("completed"),
) {
  let settlement = {
    id: settlementId,
    status: initialStatus,
    version: 0,
  } as Settlement;
  let storedIntent: OzavOfframpIntent | null = intent;
  let importCalls = 0;
  const transitions: SettlementStatus[] = [];
  const processed = new Set<string>();
  const marked: string[][] = [];
  let transitionError: Error | null = null;

  const service = new ReconcileOzavOfframpService({
    importer: {
      async execute() {
        importCalls += 1;
        return provider;
      },
    },
    repository: {
      async find() {
        return storedIntent;
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
    now: () => new Date("2026-10-10T12:30:00Z"),
  });

  return {
    service,
    transitions,
    marked,
    settlement: () => settlement,
    importCalls: () => importCalls,
    unlink: () => {
      storedIntent = null;
    },
    failTransition: (error: Error) => {
      transitionError = error;
    },
  };
}

describe("OZAV off-ramp reconciliation", () => {
  it("does nothing without an off-ramp transfer", async () => {
    const subject = setup("settled");
    subject.unlink();

    await expect(subject.service.execute(settlementId))
      .resolves.toMatchObject({
        providerLinked: false,
        settlementStatus: "settled",
        eventsProcessed: 0,
      });
    expect(subject.importCalls()).toBe(0);
  });

  it("keeps an in-flight payout in offramping", async () => {
    const subject = setup(
      "offramping",
      imported("payout_initiated", "completed", "processing"),
    );

    await expect(subject.service.execute(settlementId))
      .resolves.toMatchObject({
        providerStatus: "payout_initiated",
        settlementStatus: "offramping",
        transitions: [],
        eventsProcessed: 2,
        attentionRequired: false,
      });
  });

  it("moves completed provider legs to paid_out", async () => {
    const subject = setup();

    await expect(subject.service.execute(settlementId))
      .resolves.toMatchObject({
        providerStatus: "completed",
        sourceLegStatus: "completed",
        destinationLegStatus: "completed",
        settlementStatus: "paid_out",
        transitions: ["paid_out"],
        targetAmountBrl: "499.98",
      });
    expect(subject.settlement().version).toBe(1);
  });

  it("is idempotent after paid_out", async () => {
    const subject = setup("paid_out");

    expect(await subject.service.execute(settlementId))
      .toMatchObject({
        settlementStatus: "paid_out",
        transitions: [],
        eventsProcessed: 2,
      });
    expect(await subject.service.execute(settlementId))
      .toMatchObject({
        transitions: [],
        eventsProcessed: 0,
      });
    expect(subject.settlement().version).toBe(0);
  });

  it("requires both completed legs before paid_out", async () => {
    const subject = setup(
      "offramping",
      imported("completed", "completed", "processing"),
    );

    await expect(subject.service.execute(settlementId))
      .rejects.toThrow("incomplete settlement leg");
    expect(subject.marked).toEqual([]);
  });

  it("moves a provider failure to failed", async () => {
    const subject = setup(
      "offramping",
      imported("failed", "processing", "failed"),
    );

    await expect(subject.service.execute(settlementId))
      .resolves.toMatchObject({
        settlementStatus: "failed",
        transitions: ["failed"],
        attentionRequired: false,
      });
  });

  it("flags a failure after source settlement for attention", async () => {
    const subject = setup(
      "offramping",
      imported("cancelled", "completed", "cancelled"),
    );

    await expect(subject.service.execute(settlementId))
      .resolves.toMatchObject({
        settlementStatus: "failed",
        attentionRequired: true,
      });
  });

  it("keeps needs_review open and visible", async () => {
    const subject = setup(
      "offramping",
      imported("needs_review", "completed", "needs_review"),
    );

    await expect(subject.service.execute(settlementId))
      .resolves.toMatchObject({
        settlementStatus: "offramping",
        transitions: [],
        attentionRequired: true,
      });
  });

  it("rejects contradictions with terminal settlement state", async () => {
    const paidOut = setup(
      "paid_out",
      imported("failed", "completed", "failed"),
    );
    await expect(paidOut.service.execute(settlementId))
      .rejects.toThrow("conflicts with settlement status");
    expect(paidOut.marked).toEqual([]);

    const failed = setup("failed", imported("completed"));
    await expect(failed.service.execute(settlementId))
      .rejects.toThrow("conflicts with settlement status");
  });

  it("does not acknowledge events when transition fails", async () => {
    const subject = setup();
    subject.failTransition(new Error("concurrent update"));

    await expect(subject.service.execute(settlementId))
      .rejects.toThrow("concurrent update");
    expect(subject.marked).toEqual([]);
  });

  it("rejects reconciliation before offramping", async () => {
    const subject = setup("settled");

    await expect(subject.service.execute(settlementId))
      .rejects.toThrow("Cannot reconcile");
    expect(subject.importCalls()).toBe(0);
  });
});
