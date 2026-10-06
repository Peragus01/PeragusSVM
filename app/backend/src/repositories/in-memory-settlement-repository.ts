import type { Settlement } from "../domain/settlement.js";
import type {
  CreateOrGetSettlementResult,
  SettlementRepository,
  UpdateSettlementStatusInput,
} from "./settlement-repository.js";

export class InMemorySettlementRepository
  implements SettlementRepository
{
  private readonly settlementsByRequestId =
    new Map<string, Settlement>();

  private readonly settlementsById =
    new Map<string, Settlement>();

  async createOrGet(
    settlement: Settlement,
  ): Promise<CreateOrGetSettlementResult> {
    const existing = this.settlementsByRequestId.get(
      settlement.requestId,
    );

    if (existing) {
      return {
        settlement: existing,
        created: false,
      };
    }

    this.settlementsByRequestId.set(
      settlement.requestId,
      settlement,
    );

    this.settlementsById.set(
      settlement.id,
      settlement,
    );

    return {
      settlement,
      created: true,
    };
  }

  async findById(id: string): Promise<Settlement | null> {
    return this.settlementsById.get(id) ?? null;
  }

  async findByRequestId(
    requestId: string,
  ): Promise<Settlement | null> {
    return this.settlementsByRequestId.get(requestId) ?? null;
  }

  async updateStatus(
    input: UpdateSettlementStatusInput,
  ): Promise<Settlement | null> {
    const current = this.settlementsById.get(input.id);

    if (
      !current
      || current.status !== input.expectedStatus
      || current.version !== input.expectedVersion
    ) {
      return null;
    }

    const updated: Settlement = {
      ...current,
      status: input.nextStatus,
      version: current.version + 1,
      updatedAt: input.occurredAt,
    };

    this.settlementsById.set(updated.id, updated);
    this.settlementsByRequestId.set(
      updated.requestId,
      updated,
    );

    return updated;
  }
}
