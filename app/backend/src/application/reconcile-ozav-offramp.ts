import type {
  Settlement,
  SettlementStatus,
} from "../domain/settlement.js";
import {
  OzavOfframpInitiationError,
  type OzavOfframpIntent,
  type OzavTransferStatus,
} from "../domain/ozav-offramp-intent.js";
import type { OzavOfframpReconciliationRepository } from "../repositories/ozav-offramp-reconciliation-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";
import type { OzavOfframpImportResult } from "./import-ozav-offramp-events.js";

const terminalFailures = new Set<OzavTransferStatus>([
  "failed",
  "cancelled",
  "expired",
]);

const pendingStatuses = new Set<OzavTransferStatus>([
  "awaiting_payment",
  "payment_confirmed",
  "converting",
  "payout_initiated",
]);

export interface OzavOfframpEventImporter {
  execute(
    intent: OzavOfframpIntent,
  ): Promise<OzavOfframpImportResult>;
}

export interface OzavOfframpSettlementTransitioner {
  execute(input: {
    settlementId: string;
    nextStatus: SettlementStatus;
  }): Promise<Settlement>;
}

export interface ReconcileOzavOfframpDependencies {
  importer: OzavOfframpEventImporter;
  repository: Pick<
    OzavOfframpReconciliationRepository,
    "find" | "markEventsProcessed"
  >;
  settlements: Pick<SettlementRepository, "findById">;
  transitioner: OzavOfframpSettlementTransitioner;
  now?: () => Date;
}

export interface OzavOfframpReconciliationResult {
  settlementId: string;
  providerLinked: boolean;
  transferId: string | null;
  providerStatus: OzavTransferStatus | null;
  sourceLegStatus: string | null;
  destinationLegStatus: string | null;
  sourceAmountUsdt: string | null;
  targetAmountBrl: string | null;
  settlementStatus: SettlementStatus;
  transitions: SettlementStatus[];
  eventsFound: number;
  eventsInserted: number;
  eventsProcessed: number;
  attentionRequired: boolean;
}

function targetForProvider(
  imported: OzavOfframpImportResult,
): {
  target: "paid_out" | "failed" | null;
  attentionRequired: boolean;
} {
  if (imported.currentTransferStatus === "completed") {
    if (
      imported.currentSourceLegStatus !== "completed"
      || imported.currentDestinationLegStatus
        !== "completed"
    ) {
      throw new OzavOfframpInitiationError(
        "OZAV completed off-ramp has an incomplete settlement leg",
      );
    }

    return {
      target: "paid_out",
      attentionRequired: false,
    };
  }

  if (terminalFailures.has(imported.currentTransferStatus)) {
    if (imported.currentDestinationLegStatus === "completed") {
      throw new OzavOfframpInitiationError(
        "OZAV off-ramp failure conflicts with a completed destination leg",
      );
    }

    return {
      target: "failed",
      attentionRequired:
        imported.currentSourceLegStatus === "completed",
    };
  }

  if (
    imported.currentTransferStatus === "needs_review"
    || imported.currentTransferStatus
      === "awaiting_approval"
  ) {
    return {
      target: null,
      attentionRequired: true,
    };
  }

  if (pendingStatuses.has(imported.currentTransferStatus)) {
    return {
      target: null,
      attentionRequired: false,
    };
  }

  throw new OzavOfframpInitiationError(
    `Unsupported OZAV off-ramp status: ${imported.currentTransferStatus}`,
  );
}

export class ReconcileOzavOfframpService {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies:
      ReconcileOzavOfframpDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(
    settlementId: string,
  ): Promise<OzavOfframpReconciliationResult> {
    const {
      importer,
      repository,
      settlements,
      transitioner,
    } = this.dependencies;
    let settlement = await settlements.findById(settlementId);

    if (!settlement) {
      throw new OzavOfframpInitiationError(
        `Settlement not found for OZAV off-ramp reconciliation: ${settlementId}`,
      );
    }

    const intent = await repository.find(settlementId);
    if (!intent?.transferId) {
      return {
        settlementId,
        providerLinked: false,
        transferId: null,
        providerStatus: null,
        sourceLegStatus: null,
        destinationLegStatus: null,
        sourceAmountUsdt: null,
        targetAmountBrl: null,
        settlementStatus: settlement.status,
        transitions: [],
        eventsFound: 0,
        eventsInserted: 0,
        eventsProcessed: 0,
        attentionRequired: false,
      };
    }

    if (
      !["offramping", "paid_out", "failed"].includes(
        settlement.status,
      )
    ) {
      throw new OzavOfframpInitiationError(
        `Cannot reconcile OZAV off-ramp from ${settlement.status}`,
      );
    }

    const imported = await importer.execute(intent);
    const resolution = targetForProvider(imported);
    const transitions: SettlementStatus[] = [];

    if (resolution.target) {
      if (settlement.status === "offramping") {
        settlement = await transitioner.execute({
          settlementId,
          nextStatus: resolution.target,
        });
        transitions.push(resolution.target);
      } else if (settlement.status !== resolution.target) {
        throw new OzavOfframpInitiationError(
          `OZAV off-ramp ${imported.currentTransferStatus} conflicts with settlement status ${settlement.status}`,
        );
      }
    } else if (settlement.status !== "offramping") {
      throw new OzavOfframpInitiationError(
        `Non-terminal OZAV off-ramp conflicts with settlement status ${settlement.status}`,
      );
    }

    const eventsProcessed =
      await repository.markEventsProcessed(
        settlementId,
        imported.eventIds,
        this.now(),
      );

    return {
      settlementId,
      providerLinked: true,
      transferId: intent.transferId,
      providerStatus: imported.currentTransferStatus,
      sourceLegStatus:
        imported.currentSourceLegStatus,
      destinationLegStatus:
        imported.currentDestinationLegStatus,
      sourceAmountUsdt:
        imported.currentSourceAmountUsdt,
      targetAmountBrl:
        imported.currentTargetAmountBrl,
      settlementStatus: settlement.status,
      transitions,
      eventsFound: imported.eventsFound,
      eventsInserted: imported.inserted,
      eventsProcessed,
      attentionRequired: resolution.attentionRequired,
    };
  }
}
