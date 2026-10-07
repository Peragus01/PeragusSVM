import { createHash } from "node:crypto";

import { z } from "zod";

import type { OzavReconciliationResult } from "../application/reconcile-ozav-onramp.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export const OZAV_RECONCILIATION_QUEUE =
  "ozav-onramp-reconciliation";

export const OZAV_RECONCILIATION_DEAD_LETTER_QUEUE =
  "ozav-onramp-reconciliation-dead-letter";

export const ozavReconciliationJobSchema = z
  .object({
    settlementId: z.string().uuid(),
    requestId: z.string().min(1).max(128),
    attempt: z.number().int().min(1).max(1_000_000),
  })
  .strict();

export type OzavReconciliationJob = z.infer<
  typeof ozavReconciliationJobSchema
>;

export interface OzavReconciliationScheduleResult {
  jobId: string;
  attempt: number;
  scheduled: boolean;
  exhausted: boolean;
}

export interface OzavReconciliationScheduler {
  schedule(
    job: OzavReconciliationJob,
  ): Promise<OzavReconciliationScheduleResult>;
}

export interface OzavOnrampReconciler {
  execute(
    settlementId: string,
  ): Promise<OzavReconciliationResult>;
}

export function ozavReconciliationJobId(
  job: OzavReconciliationJob,
): string {
  const hex = createHash("sha256")
    .update(
      `peragus:ozav-reconciliation:${job.settlementId}:${job.attempt}`,
    )
    .digest("hex");
  const variant = (
    (Number.parseInt(hex.slice(16, 17), 16) & 0x3)
    | 0x8
  ).toString(16);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function shouldContinueOzavReconciliation(
  result: Pick<
    OzavReconciliationResult,
    "providerLinked" | "settlementStatus"
  >,
): boolean {
  return result.providerLinked
    && [
      "created",
      "awaiting_pix",
      "pix_confirmed",
    ].includes(result.settlementStatus);
}

export interface OzavReconciliationJobResult
  extends OzavReconciliationResult {
  requestId: string;
  attempt: number;
  next: OzavReconciliationScheduleResult | null;
}

export class OzavReconciliationJobHandler {
  constructor(
    private readonly settlements: Pick<
      SettlementRepository,
      "findById"
    >,
    private readonly reconciler: OzavOnrampReconciler,
    private readonly scheduler: OzavReconciliationScheduler,
  ) {}

  async execute(
    input: unknown,
  ): Promise<OzavReconciliationJobResult> {
    const job = ozavReconciliationJobSchema.parse(input);
    const settlement = await this.settlements.findById(
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

    const result = await this.reconciler.execute(
      job.settlementId,
    );
    const next = shouldContinueOzavReconciliation(result)
      ? await this.scheduler.schedule({
          settlementId: job.settlementId,
          requestId: job.requestId,
          attempt: job.attempt + 1,
        })
      : null;

    return {
      ...result,
      requestId: job.requestId,
      attempt: job.attempt,
      next,
    };
  }
}
