import { describe, expect, it } from "vitest";

import type { OzavOfframpReconciliationResult } from "../src/application/reconcile-ozav-offramp.js";
import type { OzavOfframpIntent } from "../src/domain/ozav-offramp-intent.js";
import type { Settlement } from "../src/domain/settlement.js";
import {
  OzavOfframpReconciliationJobHandler,
  ozavOfframpReconciliationJobId,
  ozavOfframpReconciliationJobSchema,
  shouldContinueOzavOfframpReconciliation,
  type OzavOfframpReconciler,
  type OzavOfframpReconciliationJob,
  type OzavOfframpReconciliationScheduler,
} from "../src/jobs/ozav-offramp-reconciliation.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";
const transferId = "ozav_tr_offramp";

const settlement = {
  id: settlementId,
  status: "offramping",
} as Settlement;

const intent = {
  settlementId,
  transferId,
} as OzavOfframpIntent;

function result(
  overrides:
    Partial<OzavOfframpReconciliationResult> = {},
): OzavOfframpReconciliationResult {
  return {
    settlementId,
    providerLinked: true,
    transferId,
    providerStatus: "payout_initiated",
    sourceLegStatus: "completed",
    destinationLegStatus: "processing",
    sourceAmountUsdt: "89.55",
    targetAmountBrl: "499.98",
    settlementStatus: "offramping",
    transitions: [],
    eventsFound: 1,
    eventsInserted: 0,
    eventsProcessed: 1,
    attentionRequired: false,
    ...overrides,
  };
}

class RecordingReconciler
  implements OzavOfframpReconciler
{
  readonly calls: string[] = [];

  constructor(
    private readonly value:
      OzavOfframpReconciliationResult,
  ) {}

  async execute(id: string) {
    this.calls.push(id);
    return this.value;
  }
}

class RecordingScheduler
  implements OzavOfframpReconciliationScheduler
{
  readonly jobs: OzavOfframpReconciliationJob[] = [];

  async schedule(job: OzavOfframpReconciliationJob) {
    this.jobs.push(job);
    return {
      jobId: ozavOfframpReconciliationJobId(job),
      attempt: job.attempt,
      scheduled: true,
      exhausted: false,
    };
  }
}

function handler(
  reconciliation: OzavOfframpReconciliationResult,
  storedIntent: OzavOfframpIntent | null = intent,
) {
  const reconciler = new RecordingReconciler(
    reconciliation,
  );
  const scheduler = new RecordingScheduler();
  const subject =
    new OzavOfframpReconciliationJobHandler(
      {
        async findById(id) {
          return id === settlementId ? settlement : null;
        },
      },
      {
        async find() {
          return storedIntent;
        },
      },
      reconciler,
      scheduler,
    );

  return { subject, reconciler, scheduler };
}

describe("OZAV off-ramp reconciliation jobs", () => {
  it("creates stable attempt-specific UUIDs", () => {
    const first = ozavOfframpReconciliationJobId({
      settlementId,
      transferId,
      attempt: 1,
    });
    const replay = ozavOfframpReconciliationJobId({
      settlementId,
      transferId,
      attempt: 1,
    });
    const next = ozavOfframpReconciliationJobId({
      settlementId,
      transferId,
      attempt: 2,
    });

    expect(first).toBe(replay);
    expect(first).not.toBe(next);
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first),
    ).toBe(true);
  });

  it("schedules another poll while offramping", async () => {
    const { subject, scheduler } = handler(result());
    const output = await subject.execute({
      settlementId,
      transferId,
      attempt: 4,
    });

    expect(output.next).toMatchObject({
      attempt: 5,
      scheduled: true,
    });
    expect(scheduler.jobs).toEqual([{
      settlementId,
      transferId,
      attempt: 5,
    }]);
  });

  it("stops after paid_out or failed", async () => {
    for (const status of ["paid_out", "failed"] as const) {
      const { subject, scheduler } = handler(result({
        settlementStatus: status,
        providerStatus:
          status === "paid_out" ? "completed" : "failed",
      }));

      const output = await subject.execute({
        settlementId,
        transferId,
        attempt: 2,
      });
      expect(output.next).toBeNull();
      expect(scheduler.jobs).toEqual([]);
    }
  });

  it("validates the persisted transfer before provider access", async () => {
    const changed = {
      ...intent,
      transferId: "ozav_tr_other",
    } as OzavOfframpIntent;
    const { subject, reconciler } = handler(
      result(),
      changed,
    );

    await expect(subject.execute({
      settlementId,
      transferId,
      attempt: 1,
    })).rejects.toThrow("unexpected OZAV off-ramp transfer");
    expect(reconciler.calls).toEqual([]);
  });

  it("validates schema and continuation state", () => {
    expect(() => ozavOfframpReconciliationJobSchema.parse({
      settlementId,
      transferId,
      attempt: 1,
      apiKey: "must-not-be-accepted",
    })).toThrow();

    expect(shouldContinueOzavOfframpReconciliation(
      result(),
    )).toBe(true);
    expect(shouldContinueOzavOfframpReconciliation(
      result({
        providerLinked: false,
        settlementStatus: "settled",
      }),
    )).toBe(false);
  });
});
