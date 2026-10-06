import {
  assertSettlementTransition,
} from "../domain/settlement-state-machine.js";
import type {
  Settlement,
  SettlementStatus,
} from "../domain/settlement.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export class SettlementNotFoundError extends Error {
  constructor(public readonly settlementId: string) {
    super(`Settlement not found: ${settlementId}`);
    this.name = "SettlementNotFoundError";
  }
}

export class SettlementConcurrencyError extends Error {
  constructor(public readonly settlementId: string) {
    super(
      `Settlement changed concurrently: ${settlementId}`,
    );
    this.name = "SettlementConcurrencyError";
  }
}

export interface TransitionSettlementInput {
  settlementId: string;
  nextStatus: SettlementStatus;
}

export class TransitionSettlementService {
  constructor(
    private readonly repository: SettlementRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    input: TransitionSettlementInput,
  ): Promise<Settlement> {
    const current = await this.repository.findById(
      input.settlementId,
    );

    if (!current) {
      throw new SettlementNotFoundError(input.settlementId);
    }

    assertSettlementTransition(
      current.status,
      input.nextStatus,
    );

    const updated = await this.repository.updateStatus({
      id: current.id,
      expectedStatus: current.status,
      expectedVersion: current.version,
      nextStatus: input.nextStatus,
      occurredAt: this.now(),
    });

    if (!updated) {
      throw new SettlementConcurrencyError(current.id);
    }

    return updated;
  }
}
