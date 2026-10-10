import {
  assertOzavOfframpTransferMatches,
  normalizeOzavOfframpBrlAmount,
  normalizeOzavTransferStatus,
  normalizeOzavUsdtAmount,
  ozavOfframpIdempotencyKey,
  OzavOfframpInitiationError,
  OzavOfframpSettlementNotFoundError,
  type OzavOfframpIntent,
} from "../domain/ozav-offramp-intent.js";
import type {
  Settlement,
  SettlementStatus,
} from "../domain/settlement.js";
import type {
  CreateOzavOfframpQuoteInput,
  CreateOzavOfframpTransferInput,
  OzavPayoutDestination,
  OzavQuote,
  OzavTransfer,
} from "../providers/ozav-client.js";
import type { OzavOfframpIntentRepository } from "../repositories/ozav-offramp-intent-repository.js";
import type { OzavOnrampRepository } from "../repositories/ozav-onramp-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export interface OzavOfframpWriter {
  getTransfer(id: string): Promise<OzavTransfer>;
  getPayoutDestination(
    id: string,
  ): Promise<OzavPayoutDestination>;
  createOfframpQuote(
    input: CreateOzavOfframpQuoteInput,
  ): Promise<OzavQuote>;
  createOfframpTransfer(
    input: CreateOzavOfframpTransferInput,
  ): Promise<{
    transfer: OzavTransfer;
    idempotentReplayed: boolean;
  }>;
}

export interface SettlementStatusTransitioner {
  execute(input: {
    settlementId: string;
    nextStatus: SettlementStatus;
  }): Promise<Settlement>;
}

export interface InitiateOzavOfframpOptions {
  client: OzavOfframpWriter;
  intents: OzavOfframpIntentRepository;
  onramps: Pick<OzavOnrampRepository, "findBinding">;
  settlements: Pick<SettlementRepository, "findById">;
  transitioner: SettlementStatusTransitioner;
  customerId: string;
  walletId: string;
  spreadBps: number;
  now?: () => Date;
}

export interface InitiateOzavOfframpInput {
  settlementId: string;
  payoutDestinationId: string;
}

export interface InitiateOzavOfframpResult {
  settlementId: string;
  settlementStatus: "offramping" | "paid_out";
  payoutDestinationId: string;
  sourceAmountUsdt: string;
  quotedTargetAmountBrl: string;
  transferTargetAmountBrl: string;
  quoteId: string;
  transferId: string;
  providerStatus: string;
  intentCreated: boolean;
  quoteCreated: boolean;
  transferReplayed: boolean;
}

export interface OzavOfframpInitiator {
  execute(
    input: InitiateOzavOfframpInput,
  ): Promise<InitiateOzavOfframpResult>;
}

function assertPayoutDestination(
  destination: OzavPayoutDestination,
  customerId: string,
  expectedId: string,
): void {
  if (
    destination.id !== expectedId
    || destination.customerId !== customerId
    || destination.currency !== "BRL"
    || destination.rail !== "pix"
    || destination.status !== "active"
  ) {
    throw new OzavOfframpInitiationError(
      "OZAV payout destination is not an active BRL Pix destination for the customer",
    );
  }
}

function assertOnrampTransfer(
  transfer: OzavTransfer,
  customerId: string,
  walletId: string,
): string {
  if (
    transfer.status !== "completed"
    || transfer.customerId !== customerId
    || transfer.destination.type !== "wallet"
    || transfer.destination.walletId !== walletId
    || transfer.amounts.target.currency !== "USDT"
  ) {
    throw new OzavOfframpInitiationError(
      "Completed OZAV on-ramp funds are not available for off-ramp",
    );
  }

  return normalizeOzavUsdtAmount(
    transfer.amounts.target.amount,
  );
}

function assertQuote(
  quote: OzavQuote,
  customerId: string,
  sourceAmountUsdt: string,
  spreadBps: number,
): void {
  if (
    quote.customerId !== customerId
    || quote.source.currency !== "USDT"
    || normalizeOzavUsdtAmount(quote.source.amount)
      !== sourceAmountUsdt
    || quote.target.currency !== "BRL"
    || quote.spreadBps !== spreadBps
  ) {
    throw new OzavOfframpInitiationError(
      "OZAV quote does not match the off-ramp intent",
    );
  }
}

export class InitiateOzavOfframpService
  implements OzavOfframpInitiator
{
  private readonly now: () => Date;

  constructor(
    private readonly options: InitiateOzavOfframpOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async ensureOfframping(
    settlementId: string,
  ): Promise<"offramping" | "paid_out"> {
    const current = await this.options.settlements.findById(
      settlementId,
    );

    if (!current) {
      throw new OzavOfframpSettlementNotFoundError(
        settlementId,
      );
    }

    if (
      current.status === "offramping"
      || current.status === "paid_out"
    ) {
      return current.status;
    }

    if (current.status !== "settled") {
      throw new OzavOfframpInitiationError(
        `Cannot initiate OZAV off-ramp from ${current.status}`,
      );
    }

    try {
      const updated = await this.options.transitioner.execute({
        settlementId,
        nextStatus: "offramping",
      });

      if (updated.status !== "offramping") {
        throw new OzavOfframpInitiationError(
          "Settlement did not enter off-ramping",
        );
      }

      return "offramping";
    } catch (error) {
      const reloaded =
        await this.options.settlements.findById(settlementId);

      if (
        reloaded?.status === "offramping"
        || reloaded?.status === "paid_out"
      ) {
        return reloaded.status;
      }

      throw error;
    }
  }

  private async resultFromIntent(
    intent: OzavOfframpIntent,
    flags: {
      intentCreated: boolean;
      quoteCreated: boolean;
      transferReplayed: boolean;
    },
  ): Promise<InitiateOzavOfframpResult> {
    if (
      !intent.quoteId
      || !intent.quoteTargetAmountBrl
      || !intent.transferId
      || !intent.providerStatus
      || !intent.transferTargetAmountBrl
    ) {
      throw new OzavOfframpInitiationError(
        "OZAV off-ramp intent is incomplete",
      );
    }

    const settlementStatus = await this.ensureOfframping(
      intent.settlementId,
    );

    return {
      settlementId: intent.settlementId,
      settlementStatus,
      payoutDestinationId: intent.payoutDestinationId,
      sourceAmountUsdt: intent.sourceAmountUsdt,
      quotedTargetAmountBrl: intent.quoteTargetAmountBrl,
      transferTargetAmountBrl:
        intent.transferTargetAmountBrl,
      quoteId: intent.quoteId,
      transferId: intent.transferId,
      providerStatus: intent.providerStatus,
      ...flags,
    };
  }

  async execute(
    input: InitiateOzavOfframpInput,
  ): Promise<InitiateOzavOfframpResult> {
    const settlement =
      await this.options.settlements.findById(
        input.settlementId,
      );

    if (!settlement) {
      throw new OzavOfframpSettlementNotFoundError(
        input.settlementId,
      );
    }

    const existing = await this.options.intents.find(
      settlement.id,
    );

    if (existing?.transferId) {
      if (
        existing.payoutDestinationId
        !== input.payoutDestinationId
      ) {
        throw new OzavOfframpInitiationError(
          "Settlement already has a different OZAV payout destination",
        );
      }

      return this.resultFromIntent(existing, {
        intentCreated: false,
        quoteCreated: false,
        transferReplayed: true,
      });
    }

    if (settlement.status !== "settled") {
      throw new OzavOfframpInitiationError(
        `Cannot initiate OZAV off-ramp from ${settlement.status}`,
      );
    }

    const onramp = await this.options.onramps.findBinding(
      settlement.id,
    );
    if (!onramp) {
      throw new OzavOfframpInitiationError(
        "Settlement has no OZAV on-ramp binding",
      );
    }

    if (
      onramp.customerId !== this.options.customerId
      || onramp.walletId !== this.options.walletId
    ) {
      throw new OzavOfframpInitiationError(
        "OZAV on-ramp binding does not match the configured customer wallet",
      );
    }

    const [onrampTransfer, payoutDestination] =
      await Promise.all([
        this.options.client.getTransfer(
          onramp.transferId,
        ),
        this.options.client.getPayoutDestination(
          input.payoutDestinationId,
        ),
      ]);
    const sourceAmountUsdt = assertOnrampTransfer(
      onrampTransfer,
      this.options.customerId,
      this.options.walletId,
    );
    assertPayoutDestination(
      payoutDestination,
      this.options.customerId,
      input.payoutDestinationId,
    );

    const reserved = await this.options.intents.reserve({
      settlementId: settlement.id,
      customerId: this.options.customerId,
      walletId: this.options.walletId,
      payoutDestinationId: input.payoutDestinationId,
      sourceAmountUsdt,
      spreadBps: this.options.spreadBps,
      idempotencyKey: ozavOfframpIdempotencyKey(
        settlement.id,
      ),
    });
    let intent = reserved.intent;
    let quoteCreated = false;

    if (!intent.quoteId) {
      const quote =
        await this.options.client.createOfframpQuote({
          customerId: intent.customerId,
          sourceAmountUsdt: intent.sourceAmountUsdt,
          spreadBps: intent.spreadBps,
        });
      assertQuote(
        quote,
        intent.customerId,
        intent.sourceAmountUsdt,
        intent.spreadBps,
      );
      intent = await this.options.intents.saveQuote({
        settlementId: intent.settlementId,
        quoteId: quote.id,
        quoteTargetAmountBrl:
          normalizeOzavOfframpBrlAmount(
            quote.target.amount,
          ),
        updatedAt: this.now(),
      });
      quoteCreated = intent.quoteId === quote.id;
    }

    if (!intent.quoteId || !intent.quoteTargetAmountBrl) {
      throw new OzavOfframpInitiationError(
        "OZAV off-ramp quote reservation is incomplete",
      );
    }

    const created =
      await this.options.client.createOfframpTransfer({
        customerId: intent.customerId,
        walletId: intent.walletId,
        payoutDestinationId:
          intent.payoutDestinationId,
        quoteId: intent.quoteId,
        idempotencyKey: intent.idempotencyKey,
        metadata: {
          project: "peragus",
          environment: "sandbox",
          flow: "offramp",
          settlement_id: settlement.id,
          request_id: settlement.requestId,
        },
      });
    assertOzavOfframpTransferMatches(
      intent,
      created.transfer,
    );

    intent = await this.options.intents.saveTransfer({
      settlementId: intent.settlementId,
      transferId: created.transfer.id,
      providerStatus: normalizeOzavTransferStatus(
        created.transfer.status,
      ),
      sourceAmountUsdt:
        created.transfer.amounts.source.amount,
      targetAmountBrl:
        created.transfer.amounts.target.amount,
      updatedAt: this.now(),
    });

    return this.resultFromIntent(intent, {
      intentCreated: reserved.created,
      quoteCreated,
      transferReplayed: created.idempotentReplayed,
    });
  }
}
