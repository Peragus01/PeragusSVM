import type {
  OzavOfframpIntent,
  OzavOfframpStoredEvent,
  OzavTransferStatus,
} from "../domain/ozav-offramp-intent.js";
import type { OzavEvent } from "../providers/ozav-client.js";

export interface UpdateOzavOfframpTransferInput {
  settlementId: string;
  transferId: string;
  providerStatus: OzavTransferStatus;
  sourceAmountUsdt: string;
  targetAmountBrl: string;
  updatedAt: Date;
}

export interface OzavOfframpReconciliationRepository {
  find(
    settlementId: string,
  ): Promise<OzavOfframpIntent | null>;

  updateTransferState(
    input: UpdateOzavOfframpTransferInput,
  ): Promise<OzavOfframpIntent>;

  recordEvent(
    intent: OzavOfframpIntent,
    event: OzavEvent,
  ): Promise<{ inserted: boolean }>;

  listEvents(
    settlementId: string,
  ): Promise<OzavOfframpStoredEvent[]>;

  markEventsProcessed(
    settlementId: string,
    eventIds: string[],
    processedAt: Date,
  ): Promise<number>;
}
