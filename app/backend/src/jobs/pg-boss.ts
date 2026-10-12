import { PgBoss } from "pg-boss";

import {
  OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE,
  OZAV_OFFRAMP_RECONCILIATION_QUEUE,
  ozavOfframpReconciliationJobId,
  ozavOfframpReconciliationJobSchema,
  type OzavOfframpReconciliationJob,
  type OzavOfframpReconciliationScheduleResult,
  type OzavOfframpReconciliationScheduler,
} from "./ozav-offramp-reconciliation.js";
import {
  OZAV_RECONCILIATION_DEAD_LETTER_QUEUE,
  OZAV_RECONCILIATION_QUEUE,
  ozavReconciliationJobId,
  ozavReconciliationJobSchema,
  type OzavReconciliationJob,
  type OzavReconciliationScheduleResult,
  type OzavReconciliationScheduler,
} from "./ozav-reconciliation.js";
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

  const ozavDeadLetterQueue = await boss.getQueue(
    OZAV_RECONCILIATION_DEAD_LETTER_QUEUE,
  );

  if (!ozavDeadLetterQueue) {
    await boss.createQueue(
      OZAV_RECONCILIATION_DEAD_LETTER_QUEUE,
      {
        policy: QUEUE_POLICY,
        retryLimit: 0,
        expireInSeconds: 60,
        retentionSeconds: 30 * 24 * 60 * 60,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
        warningQueueSize: 50,
      },
    );
  } else if (
    ozavDeadLetterQueue.policy !== QUEUE_POLICY
  ) {
    throw new Error(
      `${OZAV_RECONCILIATION_DEAD_LETTER_QUEUE} `
      + `must use the ${QUEUE_POLICY} policy`,
    );
  }

  const ozavQueue = await boss.getQueue(
    OZAV_RECONCILIATION_QUEUE,
  );

  if (!ozavQueue) {
    await boss.createQueue(
      OZAV_RECONCILIATION_QUEUE,
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
          OZAV_RECONCILIATION_DEAD_LETTER_QUEUE,
        warningQueueSize: 1_000,
      },
    );
  } else if (ozavQueue.policy !== QUEUE_POLICY) {
    throw new Error(
      `${OZAV_RECONCILIATION_QUEUE} `
      + `must use the ${QUEUE_POLICY} policy`,
    );
  }

  const ozavOfframpDeadLetterQueue = await boss.getQueue(
    OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE,
  );

  if (!ozavOfframpDeadLetterQueue) {
    await boss.createQueue(
      OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE,
      {
        policy: QUEUE_POLICY,
        retryLimit: 0,
        expireInSeconds: 60,
        retentionSeconds: 30 * 24 * 60 * 60,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
        warningQueueSize: 50,
      },
    );
  } else if (
    ozavOfframpDeadLetterQueue.policy !== QUEUE_POLICY
  ) {
    throw new Error(
      `${OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE} `
      + `must use the ${QUEUE_POLICY} policy`,
    );
  }

  const ozavOfframpQueue = await boss.getQueue(
    OZAV_OFFRAMP_RECONCILIATION_QUEUE,
  );

  if (!ozavOfframpQueue) {
    await boss.createQueue(
      OZAV_OFFRAMP_RECONCILIATION_QUEUE,
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
          OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE,
        warningQueueSize: 1_000,
      },
    );
  } else if (
    ozavOfframpQueue.policy !== QUEUE_POLICY
  ) {
    throw new Error(
      `${OZAV_OFFRAMP_RECONCILIATION_QUEUE} `
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

export class PgBossOzavReconciliationScheduler
  implements OzavReconciliationScheduler
{
  constructor(
    private readonly boss: PgBoss,
    private readonly delaySeconds: number,
    private readonly maxAttempts: number,
  ) {
    if (
      !Number.isInteger(delaySeconds)
      || delaySeconds < 1
      || !Number.isInteger(maxAttempts)
      || maxAttempts < 1
    ) {
      throw new Error(
        "Invalid OZAV reconciliation schedule configuration",
      );
    }
  }

  async schedule(
    input: OzavReconciliationJob,
    options: { immediate?: boolean } = {},
  ): Promise<OzavReconciliationScheduleResult> {
    const job = ozavReconciliationJobSchema.parse(input);
    const deterministicId = ozavReconciliationJobId(job);

    if (job.attempt > this.maxAttempts) {
      return {
        jobId: deterministicId,
        attempt: job.attempt,
        scheduled: false,
        exhausted: true,
      };
    }

    const jobId = await this.boss.sendAfter(
      OZAV_RECONCILIATION_QUEUE,
      job,
      { id: deterministicId },
      options.immediate ? 0 : this.delaySeconds,
    );

    return {
      jobId: jobId ?? deterministicId,
      attempt: job.attempt,
      scheduled: jobId !== null,
      exhausted: false,
    };
  }
}

export class PgBossOzavOfframpReconciliationScheduler
  implements OzavOfframpReconciliationScheduler
{
  constructor(
    private readonly boss: PgBoss,
    private readonly delaySeconds: number,
    private readonly maxAttempts: number,
  ) {
    if (
      !Number.isInteger(delaySeconds)
      || delaySeconds < 1
      || !Number.isInteger(maxAttempts)
      || maxAttempts < 1
    ) {
      throw new Error(
        "Invalid OZAV off-ramp reconciliation schedule configuration",
      );
    }
  }

  async schedule(
    input: OzavOfframpReconciliationJob,
  ): Promise<OzavOfframpReconciliationScheduleResult> {
    const job = ozavOfframpReconciliationJobSchema.parse(
      input,
    );
    const deterministicId =
      ozavOfframpReconciliationJobId(job);

    if (job.attempt > this.maxAttempts) {
      return {
        jobId: deterministicId,
        attempt: job.attempt,
        scheduled: false,
        exhausted: true,
      };
    }

    const jobId = await this.boss.sendAfter(
      OZAV_OFFRAMP_RECONCILIATION_QUEUE,
      job,
      { id: deterministicId },
      this.delaySeconds,
    );

    return {
      jobId: jobId ?? deterministicId,
      attempt: job.attempt,
      scheduled: jobId !== null,
      exhausted: false,
    };
  }
}
