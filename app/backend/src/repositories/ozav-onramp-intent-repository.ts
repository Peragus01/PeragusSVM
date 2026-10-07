import type {
  OzavOnrampIntent,
  OzavOnrampIntentRequest,
} from "../domain/ozav-onramp-intent.js";

export interface SaveOzavQuoteInput {
  settlementId: string;
  quoteId: string;
  quoteTargetAmountUsdt: string;
  updatedAt: Date;
}

export interface OzavOnrampIntentRepository {
  reserve(
    input: OzavOnrampIntentRequest,
  ): Promise<{
    intent: OzavOnrampIntent;
    created: boolean;
  }>;

  find(
    settlementId: string,
  ): Promise<OzavOnrampIntent | null>;

  saveQuote(
    input: SaveOzavQuoteInput,
  ): Promise<OzavOnrampIntent>;
}
