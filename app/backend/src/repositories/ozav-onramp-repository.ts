import type { OzavEvent } from "../providers/ozav-client.js";
import type { OzavOnrampBinding, OzavStoredEvent } from "../domain/ozav-onramp.js";

export interface OzavOnrampRepository {
  createBinding(binding: OzavOnrampBinding): Promise<{ binding: OzavOnrampBinding; created: boolean }>;
  findBinding(settlementId: string): Promise<OzavOnrampBinding | null>;
  recordEvent(binding: OzavOnrampBinding, event: OzavEvent): Promise<{ inserted: boolean }>;
  listEvents(settlementId: string): Promise<OzavStoredEvent[]>;
}
