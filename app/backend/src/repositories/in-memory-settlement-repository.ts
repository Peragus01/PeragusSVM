import type { Settlement } from "../domain/settlement.js";
import type {
  CreateOrGetSettlementResult,
  SettlementRepository,
} from "./settlement-repository.js";

export class InMemorySettlementRepository
  implements SettlementRepository
{
  private readonly settlementsByRequestId = new Map<string, Settlement>();

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

    return {
      settlement,
      created: true,
    };
  }
}
