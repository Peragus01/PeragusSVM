import { createHash } from "node:crypto";

import { z } from "zod";

import type { OzavOfframpReconciliationResult } from "../application/reconcile-ozav-offramp.js";
import type { OzavOfframpReconciliationRepository } from "../repositories/ozav-offramp-reconciliation-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export const OZAV_OFFRAMP_RECONCILIATION_QUEUE =
  "ozav-offramp-reconciliation";

export const OZAV_OFFRAMP_RECONCILIATION_DEAD_LETTER_QUEUE =
  "ozav-offramp-reconciliation-dead-letter";

export const ozavOfframpReconciliationJobSchema = z
  .object({
    settlementId: z.string().uuid(),
    transferId: z
      .string()
      .regex(/^ozav_tr_[A-Za-z0-9_]+$/)
      .max(128),
    attempt: z.number().int().min(1).max(1_000_000),
  })
  .strict();

export type OzavOfframpReconciliationJob = z.infer<
  typeof ozavOfframpReconciliationJobSchema
>;

export interface OzavOfframpReconciliationScheduleResult {
  jobId: string;
  attempt: number;
  scheduled: boolean;
  exhausted: boolean;
}

export interface OzavOfframpReconciliationScheduler {
  schedule(
    job: OzavOfframpReconciliationJob,
  ): Promise<OzavOfframpReconciliationScheduleResult>;
}

export interface OzavOfframpReconciler {
  execute(
    settlementId: string,
  ): Promise<OzavOfframpReconciliationResult>;
}

export function ozavOfframpReconciliationJobId(
  job: OzavOfframpReconciliationJob,
): string {
  const hex = createHash("sha256")
    .update(
      `peragus:ozav-offramp-reconciliation:${job.settlementId}:${job.transferId}:${job.attempt}`,
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

export function shouldContinueOzavOfframpReconciliation(
  result: Pick<
    OzavOfframpReconciliationResult,
    "providerLinked" | "settlementStatus"
  >,
): boolean {
  return result.providerLinked
    && result.settlementStatus === "offramping";
}

export interface OzavOfframpReconciliationJobResult
  extends OzavOfframpReconciliationResult {
  attempt: number;
  next: OzavOfframpReconciliationScheduleResult | null;
}

export class OzavOfframpReconciliationJobHandler {
  constructor(
    private readonly settlements: Pick<
      SettlementRepository,
      "findById"
    >,
    private readonly intents: Pick<
      OzavOfframpReconciliationRepository,
      "find"
    >,
    private readonly reconciler: OzavOfframpReconciler,
    private readonly scheduler:
      OzavOfframpReconciliationScheduler,
  ) {}

  async execute(
    input: unknown,
  ): Promise<OzavOfframpReconciliationJobResult> {
    const job = ozavOfframpReconciliationJobSchema.parse(
      input,
    );
    const [settlement, intent] = await Promise.all([
      this.settlements.findById(job.settlementId),
      this.intents.find(job.settlementId),
    ]);

    if (!settlement) {
      throw new Error(
        `Settlement ${job.settlementId} was not found`,
      );
    }
    if (intent?.transferId !== job.transferId) {
      throw new Error(
        `Settlement ${job.settlementId} has an unexpected OZAV off-ramp transfer`,
      );
    }

    const result = await this.reconciler.execute(
      job.settlementId,
    );
    const next = shouldContinueOzavOfframpReconciliation(
      result,
    )
      ? await this.scheduler.schedule({
          ...job,
          attempt: job.attempt + 1,
        })
      : null;

    return {
      ...result,
      attempt: job.attempt,
      next,
    };
  }
}
