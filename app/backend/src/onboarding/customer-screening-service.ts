import type { OzavClient } from "../providers/ozav-client.js";
import type { MoneyMode } from "../config/money-environment.js";
import { onboardingExternalRef, type SubmissionRepository } from "./submission-types.js";
import { ScreeningError, type ScreeningRecord, type ScreeningRepository } from "./screening-types.js";
const renderView = (row: ScreeningRecord | null, mode: MoneyMode) => row ? ({ provider_customer_id: row.providerCustomerId,
  screening_id: row.screeningId, state: row.screeningId ? "linked" : "creating",
  status: row.observation?.status ?? null, result: row.observation?.result ?? null,
  lists: row.observation?.lists ?? ["sanctions", "pep"], matches_count: row.observation?.matchesCount ?? null,
  suggested_decision: row.observation?.suggestedDecision ?? null,
  refreshed_at: row.refreshedAt, environment: mode, sandbox_only: mode === "test",
  point_in_time: true, operations_enabled: false,
}) : null;
export class CustomerScreeningService {
  constructor(private readonly repository: ScreeningRepository, private readonly submissions: SubmissionRepository,
    private readonly provider: Pick<OzavClient,"getCustomerCapabilities" | "getSandboxCustomerSnapshot" | "listCustomerScreenings" | "getCustomerScreening" | "createCustomerScreening">,
    private readonly mode: MoneyMode = "test") {}
  private view(row: ScreeningRecord | null) { return renderView(row, this.mode); }
  private async binding(customerId: string) {
    const row = await this.submissions.find(customerId);
    if (!row || row.state !== "linked" || !row.providerId) throw new ScreeningError("SCREENING_CUSTOMER_REQUIRED");
    return row;
  }
  private async capabilities(write: boolean) {
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== this.mode || !["customers","compliance"].every(v=>caps.entitlements.includes(v))
      || !["customers:read","screenings:read",...(write?["screenings:write"]:[])].every(v=>caps.scopes.includes(v))) {
      throw new ScreeningError("SCREENING_CAPABILITY_REQUIRED");
    }
  }
  async read(customerId: string) { return this.view(await this.repository.find(customerId)); }
  async start(customerId: string) {
    const binding = await this.binding(customerId), prior = await this.repository.find(customerId);
    if (prior && prior.providerCustomerId !== binding.providerId) throw new ScreeningError("SCREENING_CONFLICT");
    if (prior?.screeningId) return { data: this.view(prior), replayed: true };
    await this.capabilities(true);
    await this.provider.getSandboxCustomerSnapshot(binding.providerId!,onboardingExternalRef(customerId,this.mode));
    const row = await this.repository.reserve(customerId,binding.providerId!);
    if (row.screeningId) return { data: this.view(row), replayed: true };
    // Reconcile a previous manual request or a response lost after provider creation.
    // Never silently choose the newest screening from an ambiguous trail.
    const existing = await this.provider.listCustomerScreenings(row.providerCustomerId);
    if (existing.length > 1) throw new ScreeningError("SCREENING_RECONCILIATION_REQUIRED");
    const observation = existing.length === 1
      ? await this.provider.getCustomerScreening(row.providerCustomerId,existing[0]!.id)
      : await this.provider.createCustomerScreening(row.providerCustomerId,row.idempotencyKey);
    return { data: this.view(await this.repository.save(row,observation)), replayed: existing.length === 1 };
  }
  async refresh(customerId: string) {
    await this.capabilities(false);
    const binding = await this.binding(customerId), row = await this.repository.find(customerId);
    if (!row?.screeningId) throw new ScreeningError("SCREENING_NOT_STARTED");
    if (row.providerCustomerId !== binding.providerId) throw new ScreeningError("SCREENING_CONFLICT");
    return this.view(await this.repository.save(row,await this.provider.getCustomerScreening(row.providerCustomerId,row.screeningId)));
  }
}
