import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";

import {
  ensureSettlementQueues,
  PgBossOzavReconciliationScheduler,
} from "../src/jobs/pg-boss.js";
import {
  OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE,
  OZAV_OFFRAMP_RECONCILIATION_QUEUE,
} from "../src/jobs/ozav-offramp-reconciliation.js";
import {
  OZAV_RECONCILIATION_DEAD_LETTER_QUEUE,
  OZAV_RECONCILIATION_QUEUE,
  ozavReconciliationJobId,
  type OzavReconciliationJob,
} from "../src/jobs/ozav-reconciliation.js";
import {
  SETTLEMENT_ORCHESTRATION_DEAD_LETTER_QUEUE,
  SETTLEMENT_ORCHESTRATION_QUEUE,
} from "../src/jobs/settlement-orchestration.js";

const job: OzavReconciliationJob = {
  settlementId:
    "00000000-0000-4000-8000-000000000001",
  requestId: "pg-boss-ozav-reconciliation-test",
  attempt: 1,
};

describe("pg-boss OZAV reconciliation scheduling", () => {
  it("creates every orchestration queue", async () => {
    const created: Array<{
      name: string;
      options: Record<string, unknown>;
    }> = [];
    const boss = {
      async getQueue() {
        return null;
      },
      async createQueue(
        name: string,
        options: Record<string, unknown>,
      ) {
        created.push({ name, options });
      },
    } as unknown as PgBoss;

    await ensureSettlementQueues(boss);

    expect(created.map((entry) => entry.name)).toEqual([
      SETTLEMENT_ORCHESTRATION_DEAD_LETTER_QUEUE,
      SETTLEMENT_ORCHESTRATION_QUEUE,
      OZAV_RECONCILIATION_DEAD_LETTER_QUEUE,
      OZAV_RECONCILIATION_QUEUE,
      OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE,
      OZAV_OFFRAMP_RECONCILIATION_QUEUE,
    ]);
    expect(created[5]?.options).toMatchObject({
      retryLimit: 5,
      retryBackoff: true,
      deadLetter:
        OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE,
    });
  });

  it("delays a job with a deterministic identifier", async () => {
    const calls: unknown[][] = [];
    const expectedId = ozavReconciliationJobId(job);
    const boss = {
      async sendAfter(...input: unknown[]) {
        calls.push(input);
        return expectedId;
      },
    } as unknown as PgBoss;
    const scheduler =
      new PgBossOzavReconciliationScheduler(
        boss,
        30,
        120,
      );

    const output = await scheduler.schedule(job);

    expect(output).toEqual({
      jobId: expectedId,
      attempt: 1,
      scheduled: true,
      exhausted: false,
    });
    expect(calls).toEqual([[
      OZAV_RECONCILIATION_QUEUE,
      job,
      { id: expectedId },
      30,
    ]]);
  });

  it("reports a deduplicated delayed job", async () => {
    const boss = {
      async sendAfter() {
        return null;
      },
    } as unknown as PgBoss;
    const scheduler =
      new PgBossOzavReconciliationScheduler(
        boss,
        30,
        120,
      );

    await expect(scheduler.schedule(job)).resolves
      .toMatchObject({
        jobId: ozavReconciliationJobId(job),
        scheduled: false,
        exhausted: false,
      });
  });

  it("can wake reconciliation immediately after a sandbox payment", async () => {
    const calls: unknown[][] = [];
    const immediateJob = { ...job, attempt: 0 };
    const expectedId =
      ozavReconciliationJobId(immediateJob);
    const boss = {
      async sendAfter(...input: unknown[]) {
        calls.push(input);
        return expectedId;
      },
    } as unknown as PgBoss;
    const scheduler =
      new PgBossOzavReconciliationScheduler(
        boss,
        30,
        120,
      );

    await scheduler.schedule(immediateJob, {
      immediate: true,
    });

    expect(calls).toEqual([[
      OZAV_RECONCILIATION_QUEUE,
      immediateJob,
      { id: expectedId },
      0,
    ]]);
  });

  it("stops without publishing past the attempt limit", async () => {
    let sends = 0;
    const boss = {
      async sendAfter() {
        sends += 1;
        return "unexpected";
      },
    } as unknown as PgBoss;
    const scheduler =
      new PgBossOzavReconciliationScheduler(
        boss,
        30,
        1,
      );

    const output = await scheduler.schedule({
      ...job,
      attempt: 2,
    });

    expect(output).toMatchObject({
      attempt: 2,
      scheduled: false,
      exhausted: true,
    });
    expect(sends).toBe(0);
  });
});
