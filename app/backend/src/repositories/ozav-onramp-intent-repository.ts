import type {
  OzavOnrampIntent,
  OzavOnrampIntentRequest,
  OzavPixPaymentInstructions,
} from "../domain/ozav-onramp-intent.js";

export interface SaveOzavQuoteInput {
  settlementId: string;
  quoteId: string;
  quoteTargetAmountUsdt: string;
  updatedAt: Date;
}

export interface SaveOzavPaymentInstructionsInput {
  settlementId: string;
  paymentInstructions: OzavPixPaymentInstructions;
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

  savePaymentInstructions(
    input: SaveOzavPaymentInstructionsInput,
  ): Promise<OzavOnrampIntent>;
}
