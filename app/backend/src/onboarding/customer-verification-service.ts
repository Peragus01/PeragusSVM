import { OzavClientError, type OzavClient, type OzavVerification } from "../providers/ozav-client.js";
import type { SubmissionRepository } from "./submission-types.js";
import { onboardingExternalRef } from "./submission-types.js";
import { RegistrationSnapshotService } from "./customer-submission-service.js";
import { verificationChecks, VerificationError, type VerificationRepository, type VerificationRecord, type SimulationOutcome } from "./verification-types.js";
const observedOutcome = (value: OzavVerification): SimulationOutcome | null => value.status !== "completed" ? null
  : verificationChecks.every(check => value.checks[check] === "pass") ? "approved"
  : verificationChecks.some(check => value.checks[check] === "fail") ? "rejected" : null;
// Identity capture and AML list screening are independent evidence. Keep the legacy
// all-checks outcome conservative; simulation acknowledgment uses capture only.
const identityOutcome = (value: OzavVerification): SimulationOutcome | null => value.status !== "completed" ? null
  : (["kyc_document", "liveness", "face_match"] as const).every(check => value.checks[check] === "pass") ? "approved"
  : (["kyc_document", "liveness", "face_match"] as const).some(check => value.checks[check] === "fail") ? "rejected" : null;
const view = (row: VerificationRecord | null) => row ? ({ provider_customer_id: row.providerCustomerId,
  verification_id: row.verificationId, state: row.verificationId ? "linked" : "creating",
  status: row.observation?.status ?? null, checks: row.observation?.checks ?? {},
  identity_outcome: row.observation ? identityOutcome(row.observation) : null,
  observed_outcome: row.observation ? observedOutcome(row.observation) : null,
  refreshed_at: row.refreshedAt, last_simulated_outcome: row.lastSimulatedOutcome,
  environment: "test", sandbox_only: true, session_url: null, operations_enabled: false,
}) : null;
export class CustomerVerificationService {
  constructor(private readonly repository: VerificationRepository, private readonly submissions: SubmissionRepository,
    private readonly provider: Pick<OzavClient, "getCustomerCapabilities" | "getSandboxCustomerSnapshot" | "listCustomerVerifications" | "createCustomerVerification" | "getCustomerVerification" | "simulateCustomerVerification">) {}
  private async capabilities(write: boolean) {
    const caps = await this.provider.getCustomerCapabilities();
    const scopes = ["customers:read", "verifications:read", ...(write ? ["verifications:write"] : [])];
    if (caps.environment !== "test" || !["customers", "compliance"].every(value => caps.entitlements.includes(value))
      || !scopes.every(value => caps.scopes.includes(value))) throw new VerificationError("VERIFICATION_CAPABILITY_REQUIRED");
  }
  private async binding(customerId: string) {
    const row = await this.submissions.find(customerId);
    if (!row || row.state !== "linked" || !row.providerId) throw new VerificationError("VERIFICATION_CUSTOMER_REQUIRED");
    return row;
  }
  private assertIdentity(row: VerificationRecord, observation: OzavVerification) {
    if (observation.customerId !== row.providerCustomerId || (row.verificationId && observation.id !== row.verificationId)) throw new VerificationError("VERIFICATION_CONFLICT");
  }
  async read(customerId: string) { return view(await this.repository.find(customerId)); }
  private async recover(row: VerificationRecord) {
    const sessions = await this.provider.listCustomerVerifications(row.providerCustomerId);
    if (sessions.length === 0) return null;
    if (sessions.length !== 1) throw new VerificationError("VERIFICATION_RECOVERY_REQUIRED");
    const found = await this.provider.getCustomerVerification(row.providerCustomerId, sessions[0]!.id);
    this.assertIdentity(row, found);
    if (!verificationChecks.every(check => found.checks[check] !== undefined)) throw new VerificationError("VERIFICATION_RECOVERY_REQUIRED");
    return found;
  }
  async start(customerId: string) {
    const binding = await this.binding(customerId);
    const prior = await this.repository.find(customerId);
    if (prior && prior.providerCustomerId !== binding.providerId) throw new VerificationError("VERIFICATION_CONFLICT");
    if (prior?.verificationId) return { data: view(prior), replayed: true };
    await this.capabilities(true);
    const snapshot = await this.provider.getSandboxCustomerSnapshot(binding.providerId!, onboardingExternalRef(customerId));
    if (snapshot.verification_mode !== "full") throw new VerificationError("VERIFICATION_FULL_MODE_REQUIRED");
    let row = await this.repository.reserve(customerId, binding.providerId!);
    if (row.verificationId) return { data: view(row), replayed: true };
    const recovered = await this.recover(row);
    if (recovered) return { data: view(await this.repository.save(row, recovered)), replayed: true };
    if (row.createAttempted) throw new VerificationError("VERIFICATION_RECOVERY_REQUIRED");
    if (!await this.repository.claimCreate(customerId)) throw new VerificationError("VERIFICATION_PROCESSING");
    row = (await this.repository.find(customerId))!;
    let observation: OzavVerification;
    try { observation = await this.provider.createCustomerVerification(row.providerCustomerId); }
    catch (error) {
      if (!(error instanceof OzavClientError) || error.statusCode !== 409) throw error;
      const found = await this.recover(row);
      if (!found) throw error;
      observation = found;
    }
    this.assertIdentity(row, observation);
    return { data: view(await this.repository.save(row, observation)), replayed: false };
  }
  private async linked(customerId: string) {
    const binding = await this.binding(customerId), row = await this.repository.find(customerId);
    if (!row?.verificationId) throw new VerificationError("VERIFICATION_NOT_STARTED");
    if (row.providerCustomerId !== binding.providerId) throw new VerificationError("VERIFICATION_CONFLICT");
    return row;
  }
  async refresh(customerId: string) {
    await this.capabilities(false); const row = await this.linked(customerId);
    const observation = await this.provider.getCustomerVerification(row.providerCustomerId, row.verificationId!);
    this.assertIdentity(row, observation);
    const saved = await this.repository.save(row, observation);
    await new RegistrationSnapshotService(this.submissions, this.provider).refresh(customerId);
    return view(saved);
  }
  async simulate(customerId: string, outcome: SimulationOutcome) {
    await this.capabilities(true); const row = await this.linked(customerId);
    let observation = await this.provider.getCustomerVerification(row.providerCustomerId, row.verificationId!);
    this.assertIdentity(row, observation);
    const replayed = identityOutcome(observation) === outcome;
    if (!replayed) observation = await this.provider.simulateCustomerVerification(row.providerCustomerId, row.verificationId!, outcome);
    this.assertIdentity(row, observation);
    if (identityOutcome(observation) !== outcome) throw new VerificationError("VERIFICATION_OUTCOME_MISMATCH");
    const saved = await this.repository.save(row, observation, outcome);
    await new RegistrationSnapshotService(this.submissions, this.provider).refresh(customerId);
    return { data: view(saved), replayed };
  }
}
