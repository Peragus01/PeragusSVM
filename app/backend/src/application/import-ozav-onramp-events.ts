import {
  assertOzavOnrampMatches, normalizeOzavBinding, normalizeOzavEvent, OzavPersistenceError,
  type OzavOnrampBinding,
} from "../domain/ozav-onramp.js";
import type { OzavClient, OzavEvent } from "../providers/ozav-client.js";
import type { OzavOnrampRepository } from "../repositories/ozav-onramp-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export interface ImportOzavDependencies {
  client: Pick<OzavClient, "getCapabilities" | "getTransfer" | "listEvents">;
  repository: OzavOnrampRepository;
  settlements: Pick<SettlementRepository, "findById">;
}

/** Imports historical facts only; settlement status changes require later reconciliation. */
export class ImportOzavOnrampEventsService {
  private readonly dependencies: ImportOzavDependencies;
  constructor(dependencies: ImportOzavDependencies) { this.dependencies = dependencies; }

  async execute(input: OzavOnrampBinding): Promise<{
    settlementId: string; transferId: string; bindingCreated: boolean;
    currentTransferStatus: string; currentSourceLegStatus: string | null;
    currentDestinationLegStatus: string | null; eventIds: string[];
    eventsFound: number; inserted: number; duplicates: number;
  }> {
    const binding = normalizeOzavBinding(input);
    const { client, repository, settlements } = this.dependencies;
    if (!await settlements.findById(binding.settlementId)) {
      throw new OzavPersistenceError("Settlement not found for OZAV binding");
    }
    const capabilities = await client.getCapabilities();
    if (capabilities.environment !== "test"
      || !["transfers:read", "events:read"].every((scope) => capabilities.scopes.includes(scope))) {
      throw new OzavPersistenceError("OZAV test environment and read scopes are required");
    }

    const events: OzavEvent[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let finished = false;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await client.listEvents(cursor);
      for (const event of page.data) {
        if (event.type.startsWith("transfer.") && event.transfer?.id === binding.transferId) {
          // Validate all matching events before persisting anything.
          normalizeOzavEvent(binding, event);
          events.push(event);
        }
      }
      if (!page.hasMore) { finished = true; break; }
      if (!page.nextCursor || cursors.has(page.nextCursor)) {
        throw new OzavPersistenceError("Invalid or repeated OZAV event cursor");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (!finished) throw new OzavPersistenceError("OZAV event scan exceeded 10 pages; no events imported");

    // Re-fetch after the historical scan; event snapshots can be stale.
    const current = await client.getTransfer(binding.transferId);
    assertOzavOnrampMatches(binding, current);
    const attached = await repository.createBinding(binding);
    events.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    let inserted = 0;
    let duplicates = 0;
    for (const event of events) {
      if ((await repository.recordEvent(binding, event)).inserted) inserted += 1;
      else duplicates += 1;
    }
    return { settlementId: binding.settlementId, transferId: binding.transferId,
      bindingCreated: attached.created, currentTransferStatus: current.status,
      currentSourceLegStatus: current.sourceLegStatus,
      currentDestinationLegStatus: current.destinationLegStatus,
      eventIds: [...new Set(events.map((event) => event.id))],
      eventsFound: events.length, inserted, duplicates };
  }
}
