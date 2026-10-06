import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { buildApp } from "../src/app.js";
import {
  type SettlementJobPublisher,
  type SettlementJobPublishResult,
  type SettlementOrchestrationJob,
} from "../src/jobs/settlement-orchestration.js";

class RecordingSettlementJobPublisher
  implements SettlementJobPublisher
{
  readonly jobs: SettlementOrchestrationJob[] = [];

  async enqueue(
    job: SettlementOrchestrationJob,
  ): Promise<SettlementJobPublishResult> {
    this.jobs.push(job);

    return {
      jobId: job.settlementId,
      enqueued: true,
    };
  }
}

const applications: Awaited<
  ReturnType<typeof buildApp>
>[] = [];

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((app) => app.close()),
  );
});

describe("settlement orchestration publishing", () => {
  it("publishes the created settlement", async () => {
    const publisher =
      new RecordingSettlementJobPublisher();

    const app = await buildApp({
      settlementJobPublisher: publisher,
    });

    applications.push(app);

    const payload = {
      request_id: "queue-test-001",
      corridor_id: "ab".repeat(32),
      payer_wallet:
        "11111111111111111111111111111112",
      recipient_wallet:
        "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
      source_amount: "25000000",
      destination_amount: "37500",
      expires_at: "2099-01-01T00:00:00.000Z",
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload,
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();

    expect(publisher.jobs).toEqual([
      {
        settlementId: body.data.id,
        requestId: payload.request_id,
      },
    ]);
  });

  it("republishes an idempotent replay for recovery", async () => {
    const publisher =
      new RecordingSettlementJobPublisher();

    const app = await buildApp({
      settlementJobPublisher: publisher,
    });

    applications.push(app);

    const payload = {
      request_id: "queue-test-002",
      corridor_id: "cd".repeat(32),
      payer_wallet:
        "11111111111111111111111111111112",
      recipient_wallet:
        "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
      source_amount: "50000000",
      destination_amount: "75000",
      expires_at: "2099-01-01T00:00:00.000Z",
    };

    const created = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload,
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v1/settlements",
      payload,
    });

    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(publisher.jobs).toHaveLength(2);
    expect(publisher.jobs[0]).toEqual(
      publisher.jobs[1],
    );
  });
});
