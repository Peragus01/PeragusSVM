import type { Settlement, SettlementStatus } from "../domain/settlement.js";
import { OzavPersistenceError, type OzavOnrampBinding } from "../domain/ozav-onramp.js";
import type { OzavOnrampRepository } from "../repositories/ozav-onramp-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";
import type {
  ContingencyReserveResolutionResult,
  ContingencyReserveResolver,
} from "./resolve-solana-contingency-reserve.js";

export interface OzavImportResult {
  currentTransferStatus: string;
  currentSourceLegStatus: string | null;
  currentDestinationLegStatus: string | null;
  eventIds: string[];
  eventsFound: number;
  inserted: number;
  duplicates: number;
}

export interface OzavEventImporter {
  execute(binding: OzavOnrampBinding): Promise<OzavImportResult>;
}

export interface SettlementTransitioner {
  execute(input: {
    settlementId: string;
    nextStatus: SettlementStatus;
  }): Promise<Settlement>;
}

export interface ReconcileOzavOnrampDependencies {
  importer: OzavEventImporter;
  ozavRepository: Pick<
    OzavOnrampRepository,
    "findBinding" | "markEventsProcessed"
  >;
  settlements: Pick<SettlementRepository, "findById">;
  transitioner: SettlementTransitioner;
  contingencyReserveResolver?: ContingencyReserveResolver;
  now?: () => Date;
}

export interface OzavReconciliationResult {
  settlementId: string;
  providerLinked: boolean;
  providerStatus: string | null;
  settlementStatus: SettlementStatus;
  transitions: SettlementStatus[];
  eventsFound: number;
  eventsInserted: number;
  eventsProcessed: number;
  attentionRequired: boolean;
  contingencyReserveResolution:
    | ContingencyReserveResolutionResult
    | null;
}

const onrampPath: readonly SettlementStatus[] = [
  "created",
  "awaiting_pix",
  "pix_confirmed",
  "tokenized",
];

function targetForProvider(
  result: OzavImportResult,
): { target: SettlementStatus | null; attentionRequired: boolean } {
  switch (result.currentTransferStatus) {
    case "awaiting_payment":
      return { target: "awaiting_pix", attentionRequired: false };
    case "payment_confirmed":
    case "converting":
    case "payout_initiated":
      if (result.currentSourceLegStatus !== "completed") {
        throw new OzavPersistenceError(
          "OZAV payment status conflicts with the source leg",
        );
      }
      return { target: "pix_confirmed", attentionRequired: false };
    case "completed":
      if (
        result.currentSourceLegStatus !== "completed"
        || result.currentDestinationLegStatus !== "completed"
      ) {
        throw new OzavPersistenceError(
          "OZAV completed transfer has an incomplete settlement leg",
        );
      }
      return { target: "tokenized", attentionRequired: false };
    case "failed":
    case "cancelled":
    case "expired": {
      if (result.currentDestinationLegStatus === "completed") {
        throw new OzavPersistenceError(
          "OZAV failure conflicts with the completed destination leg",
        );
      }
      return result.currentSourceLegStatus === "completed"
        ? { target: "pix_confirmed", attentionRequired: false }
        : { target: "failed", attentionRequired: false };
    }
    case "needs_review":
    case "awaiting_approval":
      return { target: null, attentionRequired: true };
    default:
      throw new OzavPersistenceError(
        `Unsupported OZAV transfer status: ${result.currentTransferStatus}`,
      );
  }
}

function transitionsToTarget(
  current: SettlementStatus,
  target: SettlementStatus | null,
): SettlementStatus[] {
  if (target === null || current === "failed" || current === "revoked") {
    return [];
  }
  if (target === "failed") {
    if (["created", "awaiting_pix", "pix_confirmed"].includes(current)) {
      return ["failed"];
    }
    throw new OzavPersistenceError(
      `OZAV failure conflicts with advanced settlement status ${current}`,
    );
  }
  const currentIndex = onrampPath.indexOf(current);
  const targetIndex = onrampPath.indexOf(target);
  if (currentIndex >= 0) {
    return currentIndex < targetIndex
      ? [...onrampPath.slice(currentIndex + 1, targetIndex + 1)]
      : [];
  }
  // A settlement past tokenization must never be moved backwards by on-ramp data.
  return [];
}

export class ReconcileOzavOnrampService {
  private readonly dependencies: ReconcileOzavOnrampDependencies;
  private readonly now: () => Date;

  constructor(dependencies: ReconcileOzavOnrampDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(settlementId: string): Promise<OzavReconciliationResult> {
    const { importer, ozavRepository, settlements, transitioner } =
      this.dependencies;
    let settlement = await settlements.findById(settlementId);
    if (!settlement) {
      throw new OzavPersistenceError(
        `Settlement not found for OZAV reconciliation: ${settlementId}`,
      );
    }
    const binding = await ozavRepository.findBinding(settlementId);
    if (!binding) {
      return {
        settlementId,
        providerLinked: false,
        providerStatus: null,
        settlementStatus: settlement.status,
        transitions: [],
        eventsFound: 0,
        eventsInserted: 0,
        eventsProcessed: 0,
        attentionRequired: false,
        contingencyReserveResolution: null,
      };
    }

    const imported = await importer.execute(binding);
    const resolution = targetForProvider(imported);
    if (
      ["failed", "cancelled", "expired"].includes(
        imported.currentTransferStatus,
      )
      && imported.currentSourceLegStatus === "completed"
      && ![
        "created",
        "awaiting_pix",
        "pix_confirmed",
      ].includes(settlement.status)
    ) {
      throw new OzavPersistenceError(
        `OZAV failure conflicts with advanced settlement status ${settlement.status}`,
      );
    }
    const plannedTransitions = transitionsToTarget(
      settlement.status,
      resolution.target,
    );
    const appliedTransitions: SettlementStatus[] = [];
    for (const nextStatus of plannedTransitions) {
      settlement = await transitioner.execute({ settlementId, nextStatus });
      appliedTransitions.push(nextStatus);
    }
    const contingencyReserveResolution =
      this.dependencies.contingencyReserveResolver
        ? await this.dependencies.contingencyReserveResolver.execute({
            settlementId,
            corridorId: settlement.corridorId,
            recipientWallet: settlement.recipientWallet,
            providerStatus: imported.currentTransferStatus,
            sourceLegStatus:
              imported.currentSourceLegStatus,
            destinationLegStatus:
              imported.currentDestinationLegStatus,
          })
        : null;

    if (
      contingencyReserveResolution?.action === "settled"
      && settlement.status === "pix_confirmed"
    ) {
      settlement = await transitioner.execute({
        settlementId,
        nextStatus: "tokenized",
      });
      appliedTransitions.push("tokenized");
    }
    const terminalFailureAfterPayment =
      ["failed", "cancelled", "expired"].includes(
        imported.currentTransferStatus,
      )
      && imported.currentSourceLegStatus === "completed";
    const contingencyUnavailable =
      contingencyReserveResolution === null
      || contingencyReserveResolution.reason === "no_reserve";
    const eventsProcessed = await ozavRepository.markEventsProcessed(
      settlementId,
      imported.eventIds,
      this.now(),
    );
    return {
      settlementId,
      providerLinked: true,
      providerStatus: imported.currentTransferStatus,
      settlementStatus: settlement.status,
      transitions: appliedTransitions,
      eventsFound: imported.eventsFound,
      eventsInserted: imported.inserted,
      eventsProcessed,
      attentionRequired:
        resolution.attentionRequired
        || (
          contingencyReserveResolution?.action
          === "attention_required"
        )
        || (
          terminalFailureAfterPayment
          && contingencyUnavailable
        ),
      contingencyReserveResolution,
    };
  }
}
