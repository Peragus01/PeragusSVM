import { z } from "zod";

import type {
  SettlementStatus,
} from "../domain/settlement.js";
import type {
  SettlementRepository,
} from "../repositories/settlement-repository.js";

export const SETTLEMENT_ORCHESTRATION_QUEUE =
  "settlement-orchestration";

export const SETTLEMENT_ORCHESTRATION_DEAD_LETTER_QUEUE =
  "settlement-orchestration-dead-letter";

export const settlementOrchestrationJobSchema = z
  .object({
    settlementId: z.string().uuid(),
    requestId: z.string().min(1).max(128),
  })
  .strict();

export type SettlementOrchestrationJob = z.infer<
  typeof settlementOrchestrationJobSchema
>;

export interface SettlementJobPublishResult {
  jobId: string;
  enqueued: boolean;
}

export interface SettlementJobPublisher {
  enqueue(
    job: SettlementOrchestrationJob,
  ): Promise<SettlementJobPublishResult>;
}

export class NoopSettlementJobPublisher
  implements SettlementJobPublisher
{
  async enqueue(
    job: SettlementOrchestrationJob,
  ): Promise<SettlementJobPublishResult> {
    return {
      jobId: job.settlementId,
      enqueued: false,
    };
  }
}

export interface SettlementOrchestrationResult {
  settlementId: string;
  requestId: string;
  status: SettlementStatus;
  version: number;
}

export class SettlementOrchestrationHandler {
  constructor(
    private readonly repository: SettlementRepository,
  ) {}

  async execute(
    input: unknown,
  ): Promise<SettlementOrchestrationResult> {
    const job =
      settlementOrchestrationJobSchema.parse(input);

    const settlement = await this.repository.findById(
      job.settlementId,
    );

    if (!settlement) {
      throw new Error(
        `Settlement ${job.settlementId} was not found`,
      );
    }

    if (settlement.requestId !== job.requestId) {
      throw new Error(
        `Settlement ${job.settlementId} has an unexpected request_id`,
      );
    }

    return {
      settlementId: settlement.id,
      requestId: settlement.requestId,
      status: settlement.status,
      version: settlement.version,
    };
  }
}
