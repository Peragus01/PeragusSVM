import { OzavClientError, type OzavClient, type OzavVerification } from "../providers/ozav-client.js";
import type { SubmissionRepository } from "./submission-types.js";
import type { MoneyMode } from "../config/money-environment.js";
import { onboardingExternalRef } from "./submission-types.js";
import { RegistrationSnapshotService } from "./customer-submission-service.js";
import { isAllowedHostedSessionUrl } from "../providers/ozav-hosted-session.js";
import { verificationChecks, VerificationError, type VerificationRepository, type VerificationRecord, type SimulationOutcome } from "./verification-types.js";
const observedOutcome = (value: OzavVerification): SimulationOutcome | null => value.status !== "completed" ? null
  : verificationChecks.every(check => value.checks[check] === "pass") ? "approved"
  : verificationChecks.some(check => value.checks[check] === "fail") ? "rejected" : null;
// Identity capture and AML list screening are independent evidence. Keep the legacy
// all-checks outcome conservative; simulation acknowledgment uses capture only.
const identityOutcome = (value: OzavVerification): SimulationOutcome | null => value.status !== "completed" ? null
  : (["kyc_document", "liveness", "face_match"] as const).every(check => value.checks[check] === "pass") ? "approved"
  : (["kyc_document", "liveness", "face_match"] as const).some(check => value.checks[check] === "fail") ? "rejected" : null;
/** The session is still open for the person to complete in OZAV's hosted flow. */
const sessionOpen = (value: OzavVerification) => value.status === "pending" || value.status === "in_progress";
/** Live only: the stored hosted link, re-validated, while the session is still open. */
const hostedSessionUrl = (value: OzavVerification | null, mode: MoneyMode) =>
  mode === "live" && value && sessionOpen(value) && isAllowedHostedSessionUrl(value.sessionUrl) ? value.sessionUrl : null;
const renderView = (row: VerificationRecord | null, mode: MoneyMode) => row ? ({ provider_customer_id: row.providerCustomerId,
  verification_id: row.verificationId, state: row.verificationId ? "linked" : "creating",
  status: row.observation?.status ?? null, checks: row.observation?.checks ?? {},
  identity_outcome: row.observation ? identityOutcome(row.observation) : null,
  observed_outcome: row.observation ? observedOutcome(row.observation) : null,
  refreshed_at: row.refreshedAt, last_simulated_outcome: row.lastSimulatedOutcome,
  environment: mode, sandbox_only: mode === "test", session_url: hostedSessionUrl(row.observation, mode), operations_enabled: false,
}) : null;
export class CustomerVerificationService {
  constructor(private readonly repository: VerificationRepository, private readonly submissions: SubmissionRepository,
    private readonly provider: Pick<OzavClient, "getCustomerCapabilities" | "getSandboxCustomerSnapshot" | "listCustomerVerifications" | "createCustomerVerification" | "getCustomerVerification" | "simulateCustomerVerification">,
    private readonly mode: MoneyMode = "test") {}
  private view(row: VerificationRecord | null) { return renderView(row, this.mode); }
  private async capabilities(write: boolean) {
    const caps = await this.provider.getCustomerCapabilities();
    const scopes = ["customers:read", "verifications:read", ...(write ? ["verifications:write"] : [])];
    if (caps.environment !== this.mode || !["customers", "compliance"].every(value => caps.entitlements.includes(value))
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
  /**
   * The GET is the truth for status and checks. A GET may omit the hosted link that the
   * create returned; keep the stored link for the same verification in that case.
   */
  private async save(row: VerificationRecord, observation: OzavVerification, outcome?: SimulationOutcome) {
    const kept = this.mode === "live" && !observation.sessionUrl && row.observation?.id === observation.id && row.observation.sessionUrl
      ? { ...observation, sessionUrl: row.observation.sessionUrl } : observation;
    return this.repository.save(row, kept, outcome);
  }
  /** Live start must hand the browser a hosted session while it is open; never fabricate one. */
  private hosted(row: VerificationRecord) {
    if (this.mode === "live" && row.observation && sessionOpen(row.observation) && !hostedSessionUrl(row.observation, this.mode))
      throw new VerificationError("VERIFICATION_SESSION_UNAVAILABLE");
    return this.view(row);
  }
  async read(customerId: string) { return this.view(await this.repository.find(customerId)); }
  private async recover(row: VerificationRecord) {
    const sessions = await this.provider.listCustomerVerifications(row.providerCustomerId);
    if (sessions.length === 0) return null;
    if (sessions.length !== 1) throw new VerificationError("VERIFICATION_RECOVERY_REQUIRED");
    const found = await this.provider.getCustomerVerification(row.providerCustomerId, sessions[0]!.id);
    this.assertIdentity(row, found);
    if (!verificationChecks.every(check => found.checks[check] !== undefined)) throw new VerificationError("VERIFICATION_RECOVERY_REQUIRED");
    // A listed session can carry the hosted link the lost create response had.
    return this.mode === "live" && !found.sessionUrl && sessions[0]!.sessionUrl ? { ...found, sessionUrl: sessions[0]!.sessionUrl } : found;
  }
  /** Live replay without a usable link: re-read by GET once before failing closed. */
  private async replay(row: VerificationRecord) {
    if (this.mode === "live" && row.observation && sessionOpen(row.observation) && !hostedSessionUrl(row.observation, this.mode)) {
      await this.capabilities(false);
      const observation = await this.provider.getCustomerVerification(row.providerCustomerId, row.verificationId!);
      this.assertIdentity(row, observation);
      row = await this.save(row, observation);
    }
    return { data: this.hosted(row), replayed: true };
  }
  async start(customerId: string) {
    const binding = await this.binding(customerId);
    const prior = await this.repository.find(customerId);
    if (prior && prior.providerCustomerId !== binding.providerId) throw new VerificationError("VERIFICATION_CONFLICT");
    if (prior?.verificationId) return this.replay(prior);
    await this.capabilities(true);
    const snapshot = await this.provider.getSandboxCustomerSnapshot(binding.providerId!, onboardingExternalRef(customerId, this.mode));
    if (snapshot.verification_mode !== "full") throw new VerificationError("VERIFICATION_FULL_MODE_REQUIRED");
    let row = await this.repository.reserve(customerId, binding.providerId!);
    if (row.verificationId) return this.replay(row);
    const recovered = await this.recover(row);
    if (recovered) return { data: this.hosted(await this.save(row, recovered)), replayed: true };
    if (row.createAttempted) throw new VerificationError("VERIFICATION_RECOVERY_REQUIRED");
    if (!await this.repository.claimCreate(customerId)) throw new VerificationError("VERIFICATION_PROCESSING");
    row = (await this.repository.find(customerId))!;
    let observation: OzavVerification;
    try { observation = await this.provider.createCustomerVerification(row.providerCustomerId); }
    catch (error) {
      // OZAV documents that a 503 VERIFICATION_SESSION_UNAVAILABLE persists nothing: the
      // create may be repeated, so release the claim instead of requiring recovery.
      if (error instanceof OzavClientError && error.statusCode === 503 && error.ozavErrorCode === "VERIFICATION_SESSION_UNAVAILABLE") {
        await this.repository.releaseCreate(customerId);
        throw new VerificationError("VERIFICATION_SESSION_UNAVAILABLE");
      }
      if (!(error instanceof OzavClientError) || error.statusCode !== 409) throw error;
      const found = await this.recover(row);
      if (!found) throw error;
      observation = found;
    }
    this.assertIdentity(row, observation);
    return { data: this.hosted(await this.save(row, observation)), replayed: false };
  }
  private async linked(customerId: string) {
    const binding = await this.binding(customerId), row = await this.repository.find(customerId);
    if (!row?.verificationId) throw new VerificationError("VERIFICATION_NOT_STARTED");
    if (row.providerCustomerId !== binding.providerId) throw new VerificationError("VERIFICATION_CONFLICT");
    return row;
  }
  /** Re-reads the verification by GET (also used by the verification.updated webhook). */
  async refresh(customerId: string) {
    await this.capabilities(false); const row = await this.linked(customerId);
    const observation = await this.provider.getCustomerVerification(row.providerCustomerId, row.verificationId!);
    this.assertIdentity(row, observation);
    const saved = await this.save(row, observation);
    await new RegistrationSnapshotService(this.submissions, this.provider, this.mode).refresh(customerId);
    return this.view(saved);
  }
  async simulate(customerId: string, outcome: SimulationOutcome) {
    // Sandbox affordance only: live outcomes come from the person's hosted session.
    if (this.mode !== "test") throw new VerificationError("VERIFICATION_SIMULATION_UNAVAILABLE");
    await this.capabilities(true); const row = await this.linked(customerId);
    let observation = await this.provider.getCustomerVerification(row.providerCustomerId, row.verificationId!);
    this.assertIdentity(row, observation);
    const replayed = identityOutcome(observation) === outcome;
    if (!replayed) observation = await this.provider.simulateCustomerVerification(row.providerCustomerId, row.verificationId!, outcome);
    this.assertIdentity(row, observation);
    if (identityOutcome(observation) !== outcome) throw new VerificationError("VERIFICATION_OUTCOME_MISMATCH");
    const saved = await this.save(row, observation, outcome);
    await new RegistrationSnapshotService(this.submissions, this.provider, this.mode).refresh(customerId);
    return { data: this.view(saved), replayed };
  }
}
