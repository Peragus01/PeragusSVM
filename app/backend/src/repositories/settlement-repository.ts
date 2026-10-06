import type {
  Settlement,
  SettlementStatus,
} from "../domain/settlement.js";

export interface CreateOrGetSettlementResult {
  settlement: Settlement;
  created: boolean;
}

export interface UpdateSettlementStatusInput {
  id: string;
  expectedStatus: SettlementStatus;
  expectedVersion: number;
  nextStatus: SettlementStatus;
  occurredAt: Date;
}

export interface SettlementRepository {
  createOrGet(
    settlement: Settlement,
  ): Promise<CreateOrGetSettlementResult>;

  findById(id: string): Promise<Settlement | null>;

  findByRequestId(
    requestId: string,
  ): Promise<Settlement | null>;

  updateStatus(
    input: UpdateSettlementStatusInput,
  ): Promise<Settlement | null>;
}
