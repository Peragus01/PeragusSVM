import { randomUUID } from "node:crypto";
import { isLiveRegistrationEmail, type OzavClient, type OzavRegistrationPayload } from "../providers/ozav-client.js";
import type { IndividualDraftService } from "./individual-draft-service.js";
import type { MoneyMode } from "../config/money-environment.js";
import type { CustomerTermsService } from "./customer-terms-service.js";
import { attestationFor, onboardingExternalRef, onboardingIdempotencyKey, SubmissionError, type SubmissionAttestation, type SubmissionRecord, type SubmissionRepository } from "./submission-types.js";
import type { SubmissionVault } from "./submission-vault.js";

export const submissionView = (row: SubmissionRecord | null, mode: MoneyMode = "test") => row ? ({
  submission_id: row.id, environment: mode, sandbox_submission: mode === "test", state: row.state,
  draft_version: row.draftVersion, terms_session_id: row.termsSessionId, provider_customer_id: row.providerId,
  provider_status: row.providerStatus, verification_mode: row.verificationMode,
  provider_snapshot: row.snapshot, refreshed_at: row.refreshedAt, operations_enabled: false,
}) : null;
export class RegistrationSnapshotService {
  constructor(private readonly repository: SubmissionRepository,
    private readonly provider: Pick<OzavClient, "getCustomerCapabilities" | "getSandboxCustomerSnapshot">,
    private readonly mode: MoneyMode = "test") {}
  async refresh(customerId: string) {
    const row = await this.repository.find(customerId);
    if (!row || row.state !== "linked" || !row.providerId) throw new SubmissionError("ONBOARDING_NOT_SUBMITTED");
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== this.mode || !caps.entitlements.includes("customers") || !caps.scopes.includes("customers:read")) throw new SubmissionError("ONBOARDING_CAPABILITY_REQUIRED");
    const snapshot = await this.provider.getSandboxCustomerSnapshot(row.providerId, onboardingExternalRef(customerId, this.mode));
    return this.repository.saveSnapshot(customerId, row.providerId, row.snapshotVersion, snapshot);
  }
}
/** What the authenticated person confirmed with the request, and (live) their own e-mail. */
export interface SubmissionConfirmation { attestation: SubmissionAttestation; email?: string }
export class CustomerSubmissionService {
  constructor(private readonly repository: SubmissionRepository, private readonly vault: SubmissionVault,
    private readonly drafts: Pick<IndividualDraftService, "read">,
    private readonly terms: Pick<CustomerTermsService, "resolveForSubmission">,
    private readonly provider: Pick<OzavClient, "getCustomerCapabilities" | "createOnboardingCustomer" | "getSandboxCustomerSnapshot">,
    readonly mode: MoneyMode = "test") {}
  async read(customerId: string) { return submissionView(await this.repository.find(customerId), this.mode); }
  async refresh(customerId: string) { return submissionView(await new RegistrationSnapshotService(this.repository, this.provider, this.mode).refresh(customerId), this.mode); }
  /**
   * Test: a synthetic fixture identity (generated e-mail, test refs, test marker); the
   * person's e-mail is never sent. Live: the person's own e-mail and draft with live refs.
   */
  private registration(customerId: string, email: string | null): Pick<OzavRegistrationPayload, "external_ref" | "email" | "metadata"> {
    return this.mode === "live"
      ? { external_ref: onboardingExternalRef(customerId, "live"), email: email!, metadata: { peragus_onboarding: "true" } }
      : { external_ref: onboardingExternalRef(customerId, "test"), email: `peragus-onboarding-test-${customerId}@example.com`,
        metadata: { peragus_onboarding_test: "true" } };
  }
  async submit(customerId: string, draftVersion: number, termsSessionId: string,
    confirmation: SubmissionConfirmation | undefined = this.mode === "test" ? { attestation: "sandbox_data_confirmed" } : undefined) {
    // The attestation is per mode: live needs the person's truthfulness confirmation.
    if (confirmation?.attestation !== attestationFor(this.mode)) throw new SubmissionError("ONBOARDING_ATTESTATION_REQUIRED");
    let email: string | null = null;
    if (this.mode === "live") {
      email = confirmation.email?.trim().toLowerCase() ?? "";
      if (!isLiveRegistrationEmail(email)) throw new SubmissionError("ONBOARDING_EMAIL_REQUIRED");
    }
    let record = await this.repository.find(customerId);
    if (record && (record.draftVersion !== draftVersion || record.termsSessionId !== termsSessionId)) throw new SubmissionError("ONBOARDING_CONFLICT");
    if (record?.state === "linked") return { data: submissionView(record, this.mode), replayed: true };
    if (!record) {
      const draft = await this.drafts.read(customerId);
      if (!draft) throw new SubmissionError("ONBOARDING_DRAFT_REQUIRED");
      if (draft.version !== draftVersion) throw new SubmissionError("ONBOARDING_DRAFT_CHANGED");
      const token = await this.terms.resolveForSubmission(customerId, termsSessionId, draft.individual.legal_name);
      const { cpf, ...individual } = draft.individual;
      const payload: OzavRegistrationPayload = { type: "individual", ...this.registration(customerId, email),
        individual: { ...individual, tax_id: { country: "BR", type: "cpf", value: cpf } },
        terms_session_id: token, verification_mode: "full", custody_model: "managed", monitoring: false };
      const context = { id: randomUUID(), customerId, draftVersion, termsSessionId };
      record = await this.repository.reserve({ ...context,
        requestHash: this.vault.hash(context, payload), idempotencyKey: onboardingIdempotencyKey(customerId, this.mode),
        encryptedPayload: this.vault.seal(context, payload), state: "pending", providerId: null, providerStatus: null,
        verificationMode: null, snapshot: null, snapshotVersion: 0, refreshedAt: null, attestation: confirmation.attestation });
      if (record.state === "linked") return { data: submissionView(record, this.mode), replayed: true };
    }
    // Retry the frozen request, not a subsequently edited draft or renewed terms token.
    const context = { id: record.id, customerId, draftVersion: record.draftVersion, termsSessionId: record.termsSessionId };
    const payload = this.vault.open(context, record.encryptedPayload) as OzavRegistrationPayload;
    if (this.vault.hash(context, payload) !== record.requestHash) throw new SubmissionError("ONBOARDING_CONFLICT");
    // A frozen request from the other mode's shape (e.g. a synthetic body) is never sent.
    const expected = this.registration(customerId, this.mode === "live" ? payload.email : null);
    if (payload.external_ref !== expected.external_ref || record.idempotencyKey !== onboardingIdempotencyKey(customerId, this.mode)
      || JSON.stringify(payload.metadata) !== JSON.stringify(expected.metadata)) throw new SubmissionError("ONBOARDING_CONFLICT");
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== this.mode || !["customers", "custody"].every(value => caps.entitlements.includes(value))
      || !caps.scopes.includes("customers:write")) throw new SubmissionError("ONBOARDING_CAPABILITY_REQUIRED");
    // Kill switch onboarding: checked right before every POST, including retries of a pending request.
    await this.repository.claimAttempt?.(record);
    const result = await this.provider.createOnboardingCustomer(payload, record.idempotencyKey);
    if (result.externalRef !== payload.external_ref || result.email !== payload.email || result.verificationMode !== "full") throw new SubmissionError("ONBOARDING_CONFLICT");
    return { data: submissionView(await this.repository.complete(record, result), this.mode), replayed: false };
  }
}
