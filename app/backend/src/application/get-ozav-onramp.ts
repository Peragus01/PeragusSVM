import {
  OzavOnrampInitiationError,
  type OzavPixPaymentInstructions,
} from "../domain/ozav-onramp-intent.js";
import type {
  SettlementStatus,
} from "../domain/settlement.js";
import type { OzavOnrampIntentRepository } from "../repositories/ozav-onramp-intent-repository.js";
import type { OzavOnrampRepository } from "../repositories/ozav-onramp-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export type OzavOnrampStage =
  | "queued"
  | "quote_created"
  | "transfer_created"
  | "ready";

export interface OzavOnrampView {
  settlementId: string;
  settlementStatus: SettlementStatus;
  stage: OzavOnrampStage;
  ready: boolean;
  quoteId: string | null;
  transferId: string | null;
  sourceAmountBrl: string | null;
  quotedTargetAmountUsdt: string | null;
  paymentInstructions: OzavPixPaymentInstructions | null;
}

export class OzavOnrampSettlementNotFoundError
  extends Error
{
  constructor(public readonly settlementId: string) {
    super(`Settlement not found: ${settlementId}`);
    this.name = "OzavOnrampSettlementNotFoundError";
  }
}

export interface OzavOnrampReader {
  execute(settlementId: string): Promise<OzavOnrampView>;
}

export interface GetOzavOnrampOptions {
  settlements: SettlementRepository;
  intents: OzavOnrampIntentRepository;
  onramps: OzavOnrampRepository;
}

export class GetOzavOnrampService
  implements OzavOnrampReader
{
  constructor(
    private readonly options: GetOzavOnrampOptions,
  ) {}

  async execute(
    settlementId: string,
  ): Promise<OzavOnrampView> {
    const settlement =
      await this.options.settlements.findById(settlementId);
    if (!settlement) {
      throw new OzavOnrampSettlementNotFoundError(
        settlementId,
      );
    }
    const [intent, binding] = await Promise.all([
      this.options.intents.find(settlementId),
      this.options.onramps.findBinding(settlementId),
    ]);
    if (!intent) {
      return {
        settlementId,
        settlementStatus: settlement.status,
        stage: "queued",
        ready: false,
        quoteId: null,
        transferId: binding?.transferId ?? null,
        sourceAmountBrl: null,
        quotedTargetAmountUsdt: null,
        paymentInstructions: null,
      };
    }
    const payment = intent.paymentInstructions;
    if (
      payment
      && binding
      && payment.transferId !== binding.transferId
    ) {
      throw new OzavOnrampInitiationError(
        "Stored OZAV transfer does not match its settlement binding",
      );
    }
    const ready = payment !== null && binding !== null;
    const stage: OzavOnrampStage = ready
      ? "ready"
      : payment
        ? "transfer_created"
        : intent.quoteId
          ? "quote_created"
          : "queued";
    return {
      settlementId,
      settlementStatus: settlement.status,
      stage,
      ready,
      quoteId: intent.quoteId,
      transferId:
        payment?.transferId ?? binding?.transferId ?? null,
      sourceAmountBrl: intent.sourceAmountBrl,
      quotedTargetAmountUsdt:
        intent.quoteTargetAmountUsdt,
      paymentInstructions: ready ? payment : null,
    };
  }
}
