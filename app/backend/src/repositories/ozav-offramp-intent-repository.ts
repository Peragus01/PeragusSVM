import type {
  OzavOfframpIntent,
  OzavOfframpIntentRequest,
  OzavTransferStatus,
} from "../domain/ozav-offramp-intent.js";

export interface SaveOzavOfframpQuoteInput {
  settlementId: string;
  quoteId: string;
  quoteTargetAmountBrl: string;
  updatedAt: Date;
}

export interface SaveOzavOfframpTransferInput {
  settlementId: string;
  transferId: string;
  providerStatus: OzavTransferStatus;
  sourceAmountUsdt: string;
  targetAmountBrl: string;
  updatedAt: Date;
}

export interface OzavOfframpIntentRepository {
  reserve(
    input: OzavOfframpIntentRequest,
  ): Promise<{
    intent: OzavOfframpIntent;
    created: boolean;
  }>;

  find(
    settlementId: string,
  ): Promise<OzavOfframpIntent | null>;

  saveQuote(
    input: SaveOzavOfframpQuoteInput,
  ): Promise<OzavOfframpIntent>;

  saveTransfer(
    input: SaveOzavOfframpTransferInput,
  ): Promise<OzavOfframpIntent>;
}
