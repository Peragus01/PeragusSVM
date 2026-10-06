import { PgBoss } from "pg-boss";

import {
  SETTLEMENT_ORCHESTRATION_DEAD_LETTER_QUEUE,
  SETTLEMENT_ORCHESTRATION_QUEUE,
  settlementOrchestrationJobSchema,
  type SettlementJobPublisher,
  type SettlementJobPublishResult,
  type SettlementOrchestrationJob,
} from "./settlement-orchestration.js";

const QUEUE_POLICY = "standard";

export function createJobQueue(
  connectionString: string,
  useSsl: boolean,
): PgBoss {
  const baseOptions = {
    connectionString,
    schema: "pgboss",
    max: 5,
  };

  return new PgBoss(
    useSsl
      ? {
          ...baseOptions,
          ssl: {
            rejectUnauthorized: false,
          },
        }
      : baseOptions,
  );
}

export async function ensureSettlementQueues(
  boss: PgBoss,
): Promise<void> {
  const deadLetterQueue = await boss.getQueue(
    SETTLEMENT_ORCHESTRATION_DEAD_LETTER_QUEUE,
  );

  if (!deadLetterQueue) {
    await boss.createQueue(
      SETTLEMENT_ORCHESTRATION_DEAD_LETTER_QUEUE,
      {
        policy: QUEUE_POLICY,
        retryLimit: 0,
        expireInSeconds: 60,
        retentionSeconds: 30 * 24 * 60 * 60,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
        warningQueueSize: 50,
      },
    );
  } else if (deadLetterQueue.policy !== QUEUE_POLICY) {
    throw new Error(
      `${SETTLEMENT_ORCHESTRATION_DEAD_LETTER_QUEUE} `
      + `must use the ${QUEUE_POLICY} policy`,
    );
  }

  const orchestrationQueue = await boss.getQueue(
    SETTLEMENT_ORCHESTRATION_QUEUE,
  );

  if (!orchestrationQueue) {
    await boss.createQueue(
      SETTLEMENT_ORCHESTRATION_QUEUE,
      {
        policy: QUEUE_POLICY,
        retryLimit: 5,
        retryDelay: 5,
        retryBackoff: true,
        retryDelayMax: 300,
        expireInSeconds: 120,
        retentionSeconds: 7 * 24 * 60 * 60,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
        deadLetter:
          SETTLEMENT_ORCHESTRATION_DEAD_LETTER_QUEUE,
        warningQueueSize: 1_000,
      },
    );
  } else if (
    orchestrationQueue.policy !== QUEUE_POLICY
  ) {
    throw new Error(
      `${SETTLEMENT_ORCHESTRATION_QUEUE} `
      + `must use the ${QUEUE_POLICY} policy`,
    );
  }
}

export class PgBossSettlementJobPublisher
  implements SettlementJobPublisher
{
  constructor(private readonly boss: PgBoss) {}

  async enqueue(
    input: SettlementOrchestrationJob,
  ): Promise<SettlementJobPublishResult> {
    const job =
      settlementOrchestrationJobSchema.parse(input);

    const jobId = await this.boss.send(
      SETTLEMENT_ORCHESTRATION_QUEUE,
      job,
      {
        id: job.settlementId,
      },
    );

    return {
      jobId: jobId ?? job.settlementId,
      enqueued: jobId !== null,
    };
  }
}
