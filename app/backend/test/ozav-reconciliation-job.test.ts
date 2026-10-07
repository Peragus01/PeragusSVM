import { describe, expect, it } from "vitest";

import type { OzavReconciliationResult } from "../src/application/reconcile-ozav-onramp.js";
import type { Settlement } from "../src/domain/settlement.js";
import {
  OzavReconciliationJobHandler,
  ozavReconciliationJobId,
  ozavReconciliationJobSchema,
  shouldContinueOzavReconciliation,
  type OzavOnrampReconciler,
  type OzavReconciliationJob,
  type OzavReconciliationScheduler,
} from "../src/jobs/ozav-reconciliation.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

const settlement: Settlement = {
  id: settlementId,
  requestId: "ozav-reconciliation-job-test",
  requestPayloadHash: "a".repeat(64),
  requestPayload: {
    requestId: "ozav-reconciliation-job-test",
    corridorId: "ab".repeat(32),
    payerWallet: "11111111111111111111111111111112",
    recipientWallet:
      "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
    sourceAmount: "500000000",
    destinationAmount: "89550000",
    expiresAt: "2026-10-07T14:00:00.000Z",
  },
  corridorId: "ab".repeat(32),
  payerWallet: "11111111111111111111111111111112",
  recipientWallet:
    "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
  sourceAmount: "500000000",
  destinationAmount: "89550000",
  expiresAt: new Date("2026-10-07T14:00:00Z"),
  status: "awaiting_pix",
  version: 1,
  createdAt: new Date("2026-10-07T12:00:00Z"),
  updatedAt: new Date("2026-10-07T12:01:00Z"),
};

function result(
  overrides: Partial<OzavReconciliationResult> = {},
): OzavReconciliationResult {
  return {
    settlementId,
    providerLinked: true,
    providerStatus: "awaiting_payment",
    settlementStatus: "awaiting_pix",
    transitions: [],
    eventsFound: 1,
    eventsInserted: 0,
    eventsProcessed: 1,
    attentionRequired: false,
    ...overrides,
  };
}

class RecordingReconciler
  implements OzavOnrampReconciler
{
  readonly calls: string[] = [];

  constructor(
    private readonly value: OzavReconciliationResult,
  ) {}

  async execute(id: string) {
    this.calls.push(id);
    return this.value;
  }
}

class RecordingScheduler
  implements OzavReconciliationScheduler
{
  readonly jobs: OzavReconciliationJob[] = [];

  async schedule(job: OzavReconciliationJob) {
    this.jobs.push(job);
    return {
      jobId: ozavReconciliationJobId(job),
      attempt: job.attempt,
      scheduled: true,
      exhausted: false,
    };
  }
}

function handler(
  reconciliation: OzavReconciliationResult,
  storedSettlement: Settlement | null = settlement,
) {
  const reconciler = new RecordingReconciler(reconciliation);
  const scheduler = new RecordingScheduler();
  const subject = new OzavReconciliationJobHandler(
    {
      async findById(id) {
        return storedSettlement?.id === id
          ? storedSettlement
          : null;
      },
    },
    reconciler,
    scheduler,
  );
  return { subject, reconciler, scheduler };
}

describe("OZAV reconciliation jobs", () => {
  it("creates stable, attempt-specific UUIDs", () => {
    const first = ozavReconciliationJobId({
      settlementId,
      requestId: settlement.requestId,
      attempt: 1,
    });
    const replay = ozavReconciliationJobId({
      settlementId,
      requestId: settlement.requestId,
      attempt: 1,
    });
    const next = ozavReconciliationJobId({
      settlementId,
      requestId: settlement.requestId,
      attempt: 2,
    });
    expect(first).toBe(replay);
    expect(first === next).toBe(false);
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first),
    ).toBe(true);
  });

  it("schedules the next poll while payment is pending", async () => {
    const { subject, scheduler } = handler(result());
    const output = await subject.execute({
      settlementId,
      requestId: settlement.requestId,
      attempt: 7,
    });
    expect(output.next).toMatchObject({
      attempt: 8,
      scheduled: true,
      exhausted: false,
    });
    expect(scheduler.jobs).toEqual([{
      settlementId,
      requestId: settlement.requestId,
      attempt: 8,
    }]);
  });

  it("stops after tokenization", async () => {
    const { subject, scheduler } = handler(result({
      providerStatus: "completed",
      settlementStatus: "tokenized",
    }));
    const output = await subject.execute({
      settlementId,
      requestId: settlement.requestId,
      attempt: 3,
    });
    expect(output.next).toBeNull();
    expect(scheduler.jobs).toEqual([]);
  });

  it("does not poll an unlinked settlement", () => {
    expect(shouldContinueOzavReconciliation(result({
      providerLinked: false,
      providerStatus: null,
      settlementStatus: "created",
    }))).toBe(false);
  });

  it("validates request identity before provider access", async () => {
    const { subject, reconciler } = handler(result());
    await expect(subject.execute({
      settlementId,
      requestId: "different-request",
      attempt: 1,
    })).rejects.toThrow("unexpected request_id");
    expect(reconciler.calls).toEqual([]);
  });

  it("rejects unexpected job fields", () => {
    expect(() => ozavReconciliationJobSchema.parse({
      settlementId,
      requestId: settlement.requestId,
      attempt: 1,
      apiKey: "must-not-be-accepted",
    })).toThrow();
  });
});
