import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";

import {
  PgBossOzavOfframpReconciliationScheduler,
} from "../src/jobs/pg-boss.js";
import {
  OZAV_OFFRAMP_RECONCILIATION_QUEUE,
  ozavOfframpReconciliationJobId,
  type OzavOfframpReconciliationJob,
} from "../src/jobs/ozav-offramp-reconciliation.js";

const job: OzavOfframpReconciliationJob = {
  settlementId:
    "00000000-0000-4000-8000-000000000001",
  transferId: "ozav_tr_offramp",
  attempt: 1,
};

describe("pg-boss OZAV off-ramp reconciliation", () => {
  it("delays jobs with deterministic identifiers", async () => {
    const calls: unknown[][] = [];
    const expectedId = ozavOfframpReconciliationJobId(job);
    const boss = {
      async sendAfter(...input: unknown[]) {
        calls.push(input);
        return expectedId;
      },
    } as unknown as PgBoss;
    const scheduler =
      new PgBossOzavOfframpReconciliationScheduler(
        boss,
        30,
        120,
      );

    await expect(scheduler.schedule(job)).resolves.toEqual({
      jobId: expectedId,
      attempt: 1,
      scheduled: true,
      exhausted: false,
    });
    expect(calls).toEqual([[
      OZAV_OFFRAMP_RECONCILIATION_QUEUE,
      job,
      { id: expectedId },
      30,
    ]]);
  });

  it("reports deduplication and attempt exhaustion", async () => {
    let sends = 0;
    const boss = {
      async sendAfter() {
        sends += 1;
        return null;
      },
    } as unknown as PgBoss;
    const scheduler =
      new PgBossOzavOfframpReconciliationScheduler(
        boss,
        30,
        1,
      );

    await expect(scheduler.schedule(job)).resolves
      .toMatchObject({
        scheduled: false,
        exhausted: false,
      });
    await expect(scheduler.schedule({
      ...job,
      attempt: 2,
    })).resolves.toMatchObject({
      scheduled: false,
      exhausted: true,
    });
    expect(sends).toBe(1);
  });
});
