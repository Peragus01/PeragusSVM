import type {
  OzavOfframpStoredEvent,
  OzavTransferStatus,
} from "../domain/ozav-offramp-intent.js";
import type { OzavStoredEvent } from "../domain/ozav-onramp.js";
import type {
  Settlement,
  SettlementStatus,
} from "../domain/settlement.js";
import type { OzavOfframpReconciliationRepository } from "../repositories/ozav-offramp-reconciliation-repository.js";
import type { OzavOnrampIntentRepository } from "../repositories/ozav-onramp-intent-repository.js";
import type { OzavOnrampRepository } from "../repositories/ozav-onramp-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";
import type { SolanaContingencyReserveRepository } from "../repositories/solana-contingency-reserve-repository.js";
import type { SolanaSettlementConfirmationRepository } from "../repositories/solana-settlement-confirmation-repository.js";

export class SettlementAuditNotFoundError extends Error {
  constructor(public readonly settlementId: string) {
    super(`Settlement not found: ${settlementId}`);
    this.name = "SettlementAuditNotFoundError";
  }
}

export interface SettlementAuditEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  contentHash: string;
  providerStatus: string;
  sourceLegStatus: string | null;
  destinationLegStatus: string | null;
  sourceAmount: string;
  sourceCurrency: "BRL" | "USDT";
  targetAmount: string;
  targetCurrency: "BRL" | "USDT";
}

export interface SettlementAuditView {
  generatedAt: Date;
  settlement: {
    id: string;
    requestId: string;
    corridorId: string;
    status: SettlementStatus;
    version: number;
    sourceAmountBaseUnits: string;
    destinationAmountBaseUnits: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
  };
  onramp: {
    transferId: string | null;
    quoteId: string | null;
    providerStatus: string | null;
    sourceLegStatus: string | null;
    destinationLegStatus: string | null;
    sourceAmountBrl: string | null;
    targetAmountUsdt: string | null;
    pixExpiresAt: Date | null;
    createdAt: Date | null;
    updatedAt: Date | null;
    identityConsistent: boolean;
    events: SettlementAuditEvent[];
  } | null;
  contingencyReserve: {
    status: "funded" | "settled" | "refunded";
    reservePda: string;
    vaultPda: string;
    amountUsdt: string;
    amountBaseUnits: string;
    fallbackAfter: Date;
    expiresAt: Date;
    createSignature: string;
    resolutionAction: "pending" | "settled" | "refunded";
    resolutionSignature: string | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  solanaSettlement: {
    settlementPda: string | null;
    createSignature: string | null;
    executeSignature: string | null;
    atomicSignature: string | null;
    verified: boolean;
  } | null;
  offramp: {
    transferId: string | null;
    quoteId: string | null;
    payoutDestinationId: string;
    providerStatus: OzavTransferStatus | null;
    sourceLegStatus: string | null;
    destinationLegStatus: string | null;
    sourceAmountUsdt: string;
    quotedTargetAmountBrl: string | null;
    transferTargetAmountBrl: string | null;
    createdAt: Date;
    updatedAt: Date;
    identityConsistent: boolean;
    events: SettlementAuditEvent[];
  } | null;
  checks: {
    onrampCompleted: boolean;
    reserveResolved: boolean;
    solanaTransactionRecorded: boolean;
    offrampCompleted: boolean;
    settlementPaidOut: boolean;
    evidenceComplete: boolean;
  };
  warnings: string[];
}

export interface SettlementAuditReader {
  execute(settlementId: string): Promise<SettlementAuditView>;
}

export interface GetSettlementAuditOptions {
  settlements: Pick<SettlementRepository, "findById">;
  onrampIntents: Pick<
    OzavOnrampIntentRepository,
    "find"
  >;
  onramps: Pick<
    OzavOnrampRepository,
    "findBinding" | "listEvents"
  >;
  contingencyReserves: Pick<
    SolanaContingencyReserveRepository,
    "find"
  >;
  solanaSettlements: Pick<
    SolanaSettlementConfirmationRepository,
    "findBySettlementId"
  >;
  offramps: Pick<
    OzavOfframpReconciliationRepository,
    "find" | "listEvents"
  >;
  now?: () => Date;
}

function orderedEvents<T extends {
  eventId: string;
  occurredAt: string;
}>(events: T[]): T[] {
  return [...events].sort((left, right) =>
    Date.parse(left.occurredAt)
      - Date.parse(right.occurredAt)
    || left.eventId.localeCompare(right.eventId)
  );
}

function mapOnrampEvent(
  event: OzavStoredEvent,
): SettlementAuditEvent {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    contentHash: event.contentHash,
    providerStatus: event.snapshot.status,
    sourceLegStatus: event.snapshot.sourceLegStatus,
    destinationLegStatus:
      event.snapshot.destinationLegStatus,
    sourceAmount: event.snapshot.sourceAmountBrl,
    sourceCurrency: "BRL",
    targetAmount: event.snapshot.targetAmountUsdt,
    targetCurrency: "USDT",
  };
}

function mapOfframpEvent(
  event: OzavOfframpStoredEvent,
): SettlementAuditEvent {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    contentHash: event.contentHash,
    providerStatus: event.snapshot.status,
    sourceLegStatus: event.snapshot.sourceLegStatus,
    destinationLegStatus:
      event.snapshot.destinationLegStatus,
    sourceAmount: event.snapshot.sourceAmountUsdt,
    sourceCurrency: "USDT",
    targetAmount: event.snapshot.targetAmountBrl,
    targetCurrency: "BRL",
  };
}

function sameNonNullValues(
  values: Array<string | null | undefined>,
): boolean {
  const present = values.filter(
    (value): value is string => value !== null
      && value !== undefined,
  );

  return present.length < 2
    || present.every((value) => value === present[0]);
}

function settlementView(settlement: Settlement) {
  return {
    id: settlement.id,
    requestId: settlement.requestId,
    corridorId: settlement.corridorId,
    status: settlement.status,
    version: settlement.version,
    sourceAmountBaseUnits: settlement.sourceAmount,
    destinationAmountBaseUnits:
      settlement.destinationAmount,
    expiresAt: settlement.expiresAt,
    createdAt: settlement.createdAt,
    updatedAt: settlement.updatedAt,
  };
}

export class GetSettlementAuditService
  implements SettlementAuditReader
{
  private readonly now: () => Date;

  constructor(
    private readonly options: GetSettlementAuditOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    settlementId: string,
  ): Promise<SettlementAuditView> {
    const settlement =
      await this.options.settlements.findById(settlementId);

    if (!settlement) {
      throw new SettlementAuditNotFoundError(settlementId);
    }

    const [
      onrampIntent,
      onrampBinding,
      rawOnrampEvents,
      reserve,
      solanaState,
      offrampIntent,
      rawOfframpEvents,
    ] = await Promise.all([
      this.options.onrampIntents.find(settlementId),
      this.options.onramps.findBinding(settlementId),
      this.options.onramps.listEvents(settlementId),
      this.options.contingencyReserves.find(settlementId),
      this.options.solanaSettlements.findBySettlementId(
        settlementId,
      ),
      this.options.offramps.find(settlementId),
      this.options.offramps.listEvents(settlementId),
    ]);

    const onrampEvents = orderedEvents(rawOnrampEvents);
    const latestOnrampEvent = onrampEvents.at(-1);
    const onrampTransferId = onrampBinding?.transferId
      ?? onrampIntent?.paymentInstructions?.transferId
      ?? latestOnrampEvent?.transferId
      ?? null;
    const onrampIdentityConsistent = sameNonNullValues([
      onrampBinding?.transferId,
      onrampIntent?.paymentInstructions?.transferId,
      ...onrampEvents.map((event) => event.transferId),
    ]) && sameNonNullValues([
      onrampBinding?.quoteId,
      onrampIntent?.quoteId,
    ]);
    const hasOnrampEvidence = Boolean(
      onrampIntent
      || onrampBinding
      || onrampEvents.length,
    );
    const onramp = hasOnrampEvidence
      ? {
          transferId: onrampTransferId,
          quoteId:
            onrampBinding?.quoteId
            ?? onrampIntent?.quoteId
            ?? null,
          providerStatus:
            latestOnrampEvent?.snapshot.status ?? null,
          sourceLegStatus:
            latestOnrampEvent?.snapshot.sourceLegStatus
            ?? null,
          destinationLegStatus:
            latestOnrampEvent?.snapshot
              .destinationLegStatus ?? null,
          sourceAmountBrl:
            latestOnrampEvent?.snapshot.sourceAmountBrl
            ?? onrampIntent?.sourceAmountBrl
            ?? null,
          targetAmountUsdt:
            latestOnrampEvent?.snapshot.targetAmountUsdt
            ?? onrampIntent?.quoteTargetAmountUsdt
            ?? null,
          pixExpiresAt:
            onrampIntent?.paymentInstructions?.expiresAt
            ?? null,
          createdAt: onrampIntent?.createdAt ?? null,
          updatedAt: onrampIntent?.updatedAt ?? null,
          identityConsistent: onrampIdentityConsistent,
          events: onrampEvents.map(mapOnrampEvent),
        }
      : null;

    const reserveResolutionAction:
      | "pending"
      | "settled"
      | "refunded" = reserve?.status === "settled"
        || reserve?.status === "refunded"
        ? reserve.status
        : "pending";
    const reserveResolutionSignature = reserve?.status
      === "settled"
      ? reserve.settleSignature
      : reserve?.status === "refunded"
        ? reserve.refundSignature
        : null;
    const contingencyReserve = reserve
      ? {
          status: reserve.status,
          reservePda: reserve.reservePda,
          vaultPda: reserve.vaultPda,
          amountUsdt: reserve.amountUsdt,
          amountBaseUnits: reserve.amountBaseUnits,
          fallbackAfter: reserve.fallbackAfter,
          expiresAt: reserve.expiresAt,
          createSignature: reserve.createSignature,
          resolutionAction: reserveResolutionAction,
          resolutionSignature: reserveResolutionSignature,
          version: reserve.version,
          createdAt: reserve.createdAt,
          updatedAt: reserve.updatedAt,
        }
      : null;

    const hasSolanaEvidence = Boolean(
      solanaState?.settlementPda
      || solanaState?.createSignature
      || solanaState?.executeSignature,
    );
    const solanaVerified = Boolean(
      solanaState?.settlementPda
      && solanaState.createSignature
      && solanaState.executeSignature
      && solanaState.createSignature
        === solanaState.executeSignature,
    );
    const solanaSettlement = hasSolanaEvidence
      ? {
          settlementPda: solanaState?.settlementPda ?? null,
          createSignature:
            solanaState?.createSignature ?? null,
          executeSignature:
            solanaState?.executeSignature ?? null,
          atomicSignature: solanaVerified
            ? solanaState?.createSignature ?? null
            : null,
          verified: solanaVerified,
        }
      : null;

    const offrampEvents = orderedEvents(rawOfframpEvents);
    const latestOfframpEvent = offrampEvents.at(-1);
    const offrampIdentityConsistent = !offrampIntent
      || sameNonNullValues([
        offrampIntent.transferId,
        ...offrampEvents.map((event) => event.transferId),
      ]);
    const offramp = offrampIntent
      ? {
          transferId: offrampIntent.transferId,
          quoteId: offrampIntent.quoteId,
          payoutDestinationId:
            offrampIntent.payoutDestinationId,
          providerStatus: offrampIntent.providerStatus,
          sourceLegStatus:
            latestOfframpEvent?.snapshot.sourceLegStatus
            ?? null,
          destinationLegStatus:
            latestOfframpEvent?.snapshot
              .destinationLegStatus ?? null,
          sourceAmountUsdt:
            offrampIntent.transferSourceAmountUsdt
            ?? offrampIntent.sourceAmountUsdt,
          quotedTargetAmountBrl:
            offrampIntent.quoteTargetAmountBrl,
          transferTargetAmountBrl:
            offrampIntent.transferTargetAmountBrl,
          createdAt: offrampIntent.createdAt,
          updatedAt: offrampIntent.updatedAt,
          identityConsistent: offrampIdentityConsistent,
          events: offrampEvents.map(mapOfframpEvent),
        }
      : null;

    const onrampCompleted = Boolean(
      onrampIdentityConsistent
      && latestOnrampEvent?.snapshot.status === "completed"
      && latestOnrampEvent.snapshot.sourceLegStatus
        === "completed"
      && latestOnrampEvent.snapshot.destinationLegStatus
        === "completed",
    );
    const reserveResolved = Boolean(
      reserve
      && reserve.status !== "funded"
      && reserveResolutionSignature,
    );
    const offrampCompleted = Boolean(
      offrampIntent
      && offrampIdentityConsistent
      && offrampIntent.providerStatus === "completed"
      && latestOfframpEvent?.snapshot.status === "completed"
      && latestOfframpEvent.snapshot.sourceLegStatus
        === "completed"
      && latestOfframpEvent.snapshot.destinationLegStatus
        === "completed",
    );
    const settlementPaidOut = settlement.status === "paid_out";
    const warnings: string[] = [];

    if (!onrampIdentityConsistent) {
      warnings.push(
        "OZAV on-ramp identifiers are inconsistent",
      );
    }
    if (!offrampIdentityConsistent) {
      warnings.push(
        "OZAV off-ramp identifiers are inconsistent",
      );
    }
    if (hasSolanaEvidence && !solanaVerified) {
      warnings.push(
        "Solana settlement evidence is incomplete or inconsistent",
      );
    }

    const evidenceComplete = onrampCompleted
      && reserveResolved
      && solanaVerified
      && offrampCompleted
      && settlementPaidOut
      && warnings.length === 0;

    if (settlementPaidOut && !evidenceComplete) {
      warnings.push(
        "Paid-out settlement is missing complete audit evidence",
      );
    }

    return {
      generatedAt: this.now(),
      settlement: settlementView(settlement),
      onramp,
      contingencyReserve,
      solanaSettlement,
      offramp,
      checks: {
        onrampCompleted,
        reserveResolved,
        solanaTransactionRecorded: solanaVerified,
        offrampCompleted,
        settlementPaidOut,
        evidenceComplete,
      },
      warnings,
    };
  }
}
