import type { Settlement } from "../domain/settlement.js";

export interface CreateOrGetSettlementResult {
  settlement: Settlement;
  created: boolean;
}

export interface SettlementRepository {
  createOrGet(
    settlement: Settlement,
  ): Promise<CreateOrGetSettlementResult>;
}
