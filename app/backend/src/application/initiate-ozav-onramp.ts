import {
  normalizeOzavBrlAmount,
  normalizeOzavQuoteTargetAmount,
  ozavIdempotencyKey,
  OzavOnrampInitiationError,
  settlementAmountToBrl,
} from "../domain/ozav-onramp-intent.js";
import {
  assertOzavOnrampMatches,
  type OzavOnrampBinding,
} from "../domain/ozav-onramp.js";
import type {
  CreateOzavQuoteInput,
  CreateOzavTransferInput,
  OzavQuote,
  OzavTransfer,
} from "../providers/ozav-client.js";
import type {
  EnsureContingencyReserveResult,
  OzavContingencyReserveGate,
} from "./ensure-solana-contingency-reserve.js";
import type { OzavOnrampIntentRepository } from "../repositories/ozav-onramp-intent-repository.js";
import type { OzavOnrampRepository } from "../repositories/ozav-onramp-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export interface OzavOnrampWriter {
  createQuote(input: CreateOzavQuoteInput): Promise<OzavQuote>;
  createTransfer(input: CreateOzavTransferInput): Promise<{
    transfer: OzavTransfer;
    idempotentReplayed: boolean;
  }>;
}

export interface InitiateOzavOnrampOptions {
  client: OzavOnrampWriter;
  intents: OzavOnrampIntentRepository;
  onramps: OzavOnrampRepository;
  settlements: SettlementRepository;
  customerId: string;
  walletId: string;
  sourceDecimals: number;
  spreadBps: number;
  minimumSourceAmountBrl?: string;
  contingencyReserve?: OzavContingencyReserveGate;
  now?: () => Date;
}

export interface InitiateOzavOnrampResult {
  settlementId: string;
  transferId: string;
  quoteId: string;
  sourceAmountBrl: string | null;
  quotedTargetAmountUsdt: string | null;
  bindingCreated: boolean;
  intentCreated: boolean;
  quoteCreated: boolean;
  transferReplayed: boolean;
  paymentInstructionsAvailable: boolean;
  contingencyReserveConfirmed: boolean;
  contingencyReservePda: string | null;
}

function decimalToMinorUnits(
  input: string,
  decimals: number,
): bigint {
  const normalized = normalizeOzavBrlAmount(input);
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * (10n ** BigInt(decimals))
    + BigInt(fraction.padEnd(decimals, "0"));
}

function assertQuote(
  quote: OzavQuote,
  customerId: string,
  sourceAmountBrl: string,
  spreadBps: number,
): void {
  if (
    quote.customerId !== customerId
    || quote.source.currency !== "BRL"
    || normalizeOzavBrlAmount(quote.source.amount)
      !== sourceAmountBrl
    || quote.target.currency !== "USDT"
    || quote.spreadBps !== spreadBps
  ) {
    throw new OzavOnrampInitiationError(
      "OZAV quote does not match the on-ramp intent",
    );
  }
}

function assertPixExpiresBeforeReserve(
  pixExpiresAt: Date | string,
  reserve: EnsureContingencyReserveResult | null,
): void {
  if (!reserve) {
    return;
  }

  const expiresAt = pixExpiresAt instanceof Date
    ? pixExpiresAt
    : new Date(pixExpiresAt);

  if (
    !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() >= reserve.expiresAt.getTime()
  ) {
    throw new OzavOnrampInitiationError(
      "OZAV Pix must expire before the contingency reserve",
    );
  }
}

export class InitiateOzavOnrampService {
  private readonly client: OzavOnrampWriter;
  private readonly intents: OzavOnrampIntentRepository;
  private readonly onramps: OzavOnrampRepository;
  private readonly settlements: SettlementRepository;
  private readonly customerId: string;
  private readonly walletId: string;
  private readonly sourceDecimals: number;
  private readonly spreadBps: number;
  private readonly minimumSourceAmountBrl: string;
  private readonly contingencyReserve:
    | OzavContingencyReserveGate
    | undefined;
  private readonly now: () => Date;

  constructor(options: InitiateOzavOnrampOptions) {
    this.client = options.client;
    this.intents = options.intents;
    this.onramps = options.onramps;
    this.settlements = options.settlements;
    this.customerId = options.customerId;
    this.walletId = options.walletId;
    this.sourceDecimals = options.sourceDecimals;
    this.spreadBps = options.spreadBps;
    this.minimumSourceAmountBrl = normalizeOzavBrlAmount(
      options.minimumSourceAmountBrl ?? "400",
    );
    this.contingencyReserve = options.contingencyReserve;
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    settlementId: string,
  ): Promise<InitiateOzavOnrampResult> {
    const settlement = await this.settlements.findById(
      settlementId,
    );
    if (!settlement) {
      throw new OzavOnrampInitiationError(
        `Settlement not found: ${settlementId}`,
      );
    }

    const existingBinding =
      await this.onramps.findBinding(settlement.id);
    if (existingBinding) {
      const intent = await this.intents.find(settlement.id);
      let reserve: EnsureContingencyReserveResult | null = null;
      if (this.contingencyReserve) {
        if (!intent?.quoteTargetAmountUsdt) {
          throw new OzavOnrampInitiationError(
            "OZAV on-ramp binding exists without a quotable contingency reserve amount",
          );
        }

        reserve = await this.contingencyReserve.ensureBeforePix({
          settlementId: settlement.id,
          corridorId: settlement.corridorId,
          recipientWallet: settlement.recipientWallet,
          amountUsdt: intent.quoteTargetAmountUsdt,
          expiresAt: settlement.expiresAt,
        });
      }

      if (intent?.paymentInstructions) {
        assertPixExpiresBeforeReserve(
          intent.paymentInstructions.expiresAt,
          reserve,
        );
      }

      return {
        settlementId: settlement.id,
        transferId: existingBinding.transferId,
        quoteId: existingBinding.quoteId,
        sourceAmountBrl:
          intent?.sourceAmountBrl ?? null,
        quotedTargetAmountUsdt:
          intent?.quoteTargetAmountUsdt ?? null,
        bindingCreated: false,
        intentCreated: false,
        quoteCreated: false,
        transferReplayed: true,
        paymentInstructionsAvailable:
          intent?.paymentInstructions != null,
        contingencyReserveConfirmed:
          reserve !== null,
        contingencyReservePda:
          reserve?.reservePda ?? null,
      };
    }

    if (settlement.status !== "created") {
      throw new OzavOnrampInitiationError(
        `Cannot initiate OZAV on-ramp from ${settlement.status}`,
      );
    }
    const currentTime = this.now();
    if (settlement.expiresAt.getTime() <= currentTime.getTime()) {
      throw new OzavOnrampInitiationError(
        "Cannot initiate an expired settlement",
      );
    }

    const sourceAmountBrl = settlementAmountToBrl(
      settlement.sourceAmount,
      this.sourceDecimals,
    );
    if (
      decimalToMinorUnits(sourceAmountBrl, 2)
      < decimalToMinorUnits(this.minimumSourceAmountBrl, 2)
    ) {
      throw new OzavOnrampInitiationError(
        `OZAV on-ramp minimum is BRL ${this.minimumSourceAmountBrl}`,
      );
    }

    const reserved = await this.intents.reserve({
      settlementId: settlement.id,
      customerId: this.customerId,
      walletId: this.walletId,
      sourceAmountBrl,
      spreadBps: this.spreadBps,
      idempotencyKey: ozavIdempotencyKey(settlement.id),
    });
    let intent = reserved.intent;
    let quoteCreated = false;

    if (!intent.quoteId) {
      const quote = await this.client.createQuote({
        customerId: intent.customerId,
        sourceAmountBrl: intent.sourceAmountBrl,
        spreadBps: intent.spreadBps,
      });
      assertQuote(
        quote,
        intent.customerId,
        intent.sourceAmountBrl,
        intent.spreadBps,
      );
      intent = await this.intents.saveQuote({
        settlementId: intent.settlementId,
        quoteId: quote.id,
        quoteTargetAmountUsdt:
          normalizeOzavQuoteTargetAmount(quote.target.amount),
        updatedAt: this.now(),
      });
      quoteCreated = intent.quoteId === quote.id;
    }

    if (!intent.quoteId || !intent.quoteTargetAmountUsdt) {
      throw new OzavOnrampInitiationError(
        "OZAV quote reservation is incomplete",
      );
    }

    const reserve = this.contingencyReserve
      ? await this.contingencyReserve.ensureBeforePix({
          settlementId: settlement.id,
          corridorId: settlement.corridorId,
          recipientWallet: settlement.recipientWallet,
          amountUsdt: intent.quoteTargetAmountUsdt,
          expiresAt: settlement.expiresAt,
        })
      : null;

    const createdTransfer = await this.client.createTransfer({
      customerId: intent.customerId,
      walletId: intent.walletId,
      quoteId: intent.quoteId,
      idempotencyKey: intent.idempotencyKey,
      metadata: {
        project: "peragus",
        environment: "sandbox",
        settlement_id: settlement.id,
        request_id: settlement.requestId,
      },
    });
    const binding: OzavOnrampBinding = {
      settlementId: settlement.id,
      transferId: createdTransfer.transfer.id,
      customerId: intent.customerId,
      walletId: intent.walletId,
      quoteId: intent.quoteId,
    };
    assertOzavOnrampMatches(
      binding,
      createdTransfer.transfer,
    );
    if (
      normalizeOzavBrlAmount(
        createdTransfer.transfer.amounts.source.amount,
      ) !== intent.sourceAmountBrl
    ) {
      throw new OzavOnrampInitiationError(
        "OZAV transfer source amount does not match the intent",
      );
    }
    const payment =
      createdTransfer.transfer.source.paymentInstructions;
    if (!payment) {
      throw new OzavOnrampInitiationError(
        "OZAV transfer did not provide Pix payment instructions",
      );
    }
    assertPixExpiresBeforeReserve(payment.expiresAt, reserve);
    intent = await this.intents.savePaymentInstructions({
      settlementId: intent.settlementId,
      paymentInstructions: {
        transferId: createdTransfer.transfer.id,
        intentId: payment.intentId,
        brCode: payment.brCode,
        qrCodeImage: payment.qrCodeImage,
        expiresAt: new Date(payment.expiresAt),
      },
      updatedAt: this.now(),
    });
    if (!intent.paymentInstructions) {
      throw new OzavOnrampInitiationError(
        "OZAV Pix payment instruction reservation is incomplete",
      );
    }
    const persisted = await this.onramps.createBinding(binding);

    return {
      settlementId: settlement.id,
      transferId: persisted.binding.transferId,
      quoteId: persisted.binding.quoteId,
      sourceAmountBrl: intent.sourceAmountBrl,
      quotedTargetAmountUsdt:
        intent.quoteTargetAmountUsdt,
      bindingCreated: persisted.created,
      intentCreated: reserved.created,
      quoteCreated,
      transferReplayed:
        createdTransfer.idempotentReplayed,
      paymentInstructionsAvailable:
        intent.paymentInstructions != null,
      contingencyReserveConfirmed:
        reserve !== null,
      contingencyReservePda:
        reserve?.reservePda ?? null,
    };
  }
}
