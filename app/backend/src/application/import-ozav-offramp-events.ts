import {
  assertOzavOfframpTransferMatches,
  normalizeOzavOfframpEvent,
  normalizeOzavOfframpBrlAmount,
  normalizeOzavTransferStatus,
  normalizeOzavUsdtAmount,
  OzavOfframpInitiationError,
  type OzavOfframpIntent,
  type OzavTransferStatus,
} from "../domain/ozav-offramp-intent.js";
import type {
  OzavClient,
  OzavEvent,
} from "../providers/ozav-client.js";
import type { OzavOfframpReconciliationRepository } from "../repositories/ozav-offramp-reconciliation-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export interface OzavOfframpImportResult {
  currentTransferStatus: OzavTransferStatus;
  currentSourceLegStatus: string | null;
  currentDestinationLegStatus: string | null;
  currentSourceAmountUsdt: string;
  currentTargetAmountBrl: string;
  eventIds: string[];
  eventsFound: number;
  inserted: number;
  duplicates: number;
}

export interface ImportOzavOfframpDependencies {
  client: Pick<
    OzavClient,
    "getCapabilities" | "getTransfer" | "listEvents"
  >;
  repository: OzavOfframpReconciliationRepository;
  settlements: Pick<SettlementRepository, "findById">;
  now?: () => Date;
}

export class ImportOzavOfframpEventsService {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies:
      ImportOzavOfframpDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(
    intent: OzavOfframpIntent,
  ): Promise<OzavOfframpImportResult> {
    const {
      client,
      repository,
      settlements,
    } = this.dependencies;

    if (
      !intent.transferId
      || !intent.quoteId
      || !await settlements.findById(intent.settlementId)
    ) {
      throw new OzavOfframpInitiationError(
        "Complete OZAV off-ramp settlement data is required for reconciliation",
      );
    }

    const capabilities = await client.getCapabilities();
    if (
      capabilities.environment !== "test"
      || !["transfers:read", "events:read"].every(
        (scope) => capabilities.scopes.includes(scope),
      )
    ) {
      throw new OzavOfframpInitiationError(
        "OZAV test environment and read scopes are required for off-ramp reconciliation",
      );
    }

    const events: OzavEvent[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let finished = false;

    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await client.listEvents(cursor);

      for (const event of page.data) {
        if (
          event.type.startsWith("transfer.")
          && event.transfer?.id === intent.transferId
        ) {
          normalizeOzavOfframpEvent(intent, event);
          events.push(event);
        }
      }

      if (!page.hasMore) {
        finished = true;
        break;
      }
      if (
        !page.nextCursor
        || cursors.has(page.nextCursor)
      ) {
        throw new OzavOfframpInitiationError(
          "Invalid or repeated OZAV off-ramp event cursor",
        );
      }

      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    if (!finished) {
      throw new OzavOfframpInitiationError(
        "OZAV off-ramp event scan exceeded 10 pages",
      );
    }

    const current = await client.getTransfer(
      intent.transferId,
    );
    assertOzavOfframpTransferMatches(intent, current);

    events.sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.id.localeCompare(right.id)
    );

    let inserted = 0;
    let duplicates = 0;
    for (const event of events) {
      if ((await repository.recordEvent(intent, event)).inserted) {
        inserted += 1;
      } else {
        duplicates += 1;
      }
    }

    const providerStatus = normalizeOzavTransferStatus(
      current.status,
    );
    const sourceAmountUsdt = normalizeOzavUsdtAmount(
      current.amounts.source.amount,
    );
    const targetAmountBrl = normalizeOzavOfframpBrlAmount(
      current.amounts.target.amount,
    );

    await repository.updateTransferState({
      settlementId: intent.settlementId,
      transferId: intent.transferId,
      providerStatus,
      sourceAmountUsdt,
      targetAmountBrl,
      updatedAt: this.now(),
    });

    return {
      currentTransferStatus: providerStatus,
      currentSourceLegStatus: current.sourceLegStatus,
      currentDestinationLegStatus:
        current.destinationLegStatus,
      currentSourceAmountUsdt: sourceAmountUsdt,
      currentTargetAmountBrl: targetAmountBrl,
      eventIds: [
        ...new Set(events.map((event) => event.id)),
      ],
      eventsFound: events.length,
      inserted,
      duplicates,
    };
  }
}
