import { randomUUID } from "node:crypto";
import type { OzavClient, OzavRegistrationPayload } from "../providers/ozav-client.js";
import type { IndividualDraftService } from "./individual-draft-service.js";
import type { CustomerTermsService } from "./customer-terms-service.js";
import { onboardingExternalRef, SubmissionError, type SubmissionRecord, type SubmissionRepository } from "./submission-types.js";
import type { SubmissionVault } from "./submission-vault.js";

export const submissionView = (row: SubmissionRecord | null) => row ? ({
  submission_id: row.id, environment: "test", sandbox_submission: true, state: row.state,
  draft_version: row.draftVersion, terms_session_id: row.termsSessionId, provider_customer_id: row.providerId,
  provider_status: row.providerStatus, verification_mode: row.verificationMode,
  provider_snapshot: row.snapshot, refreshed_at: row.refreshedAt, operations_enabled: false,
}) : null;
export class RegistrationSnapshotService {
  constructor(private readonly repository: SubmissionRepository,
    private readonly provider: Pick<OzavClient, "getCustomerCapabilities" | "getSandboxCustomerSnapshot">) {}
  async refresh(customerId: string) {
    const row = await this.repository.find(customerId);
    if (!row || row.state !== "linked" || !row.providerId) throw new SubmissionError("ONBOARDING_NOT_SUBMITTED");
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== "test" || !caps.entitlements.includes("customers") || !caps.scopes.includes("customers:read")) throw new SubmissionError("ONBOARDING_CAPABILITY_REQUIRED");
    const snapshot = await this.provider.getSandboxCustomerSnapshot(row.providerId, onboardingExternalRef(customerId));
    return this.repository.saveSnapshot(customerId, row.providerId, row.snapshotVersion, snapshot);
  }
}
export class CustomerSubmissionService {
  constructor(private readonly repository: SubmissionRepository, private readonly vault: SubmissionVault,
    private readonly drafts: Pick<IndividualDraftService, "read">,
    private readonly terms: Pick<CustomerTermsService, "resolveForSubmission">,
    private readonly provider: Pick<OzavClient, "getCustomerCapabilities" | "createOnboardingCustomer" | "getSandboxCustomerSnapshot">) {}
  async read(customerId: string) { return submissionView(await this.repository.find(customerId)); }
  async refresh(customerId: string) { return submissionView(await new RegistrationSnapshotService(this.repository, this.provider).refresh(customerId)); }
  async submit(customerId: string, draftVersion: number, termsSessionId: string) {
    let record = await this.repository.find(customerId);
    if (record && (record.draftVersion !== draftVersion || record.termsSessionId !== termsSessionId)) throw new SubmissionError("ONBOARDING_CONFLICT");
    if (record?.state === "linked") return { data: submissionView(record), replayed: true };
    if (!record) {
      const draft = await this.drafts.read(customerId);
      if (!draft) throw new SubmissionError("ONBOARDING_DRAFT_REQUIRED");
      if (draft.version !== draftVersion) throw new SubmissionError("ONBOARDING_DRAFT_CHANGED");
      const token = await this.terms.resolveForSubmission(customerId, termsSessionId, draft.individual.legal_name);
      const { cpf, ...individual } = draft.individual;
      const payload: OzavRegistrationPayload = { type: "individual", external_ref: onboardingExternalRef(customerId),
        email: `peragus-onboarding-test-${customerId}@example.com`,
        individual: { ...individual, tax_id: { country: "BR", type: "cpf", value: cpf } },
        terms_session_id: token, verification_mode: "full", custody_model: "managed", monitoring: false,
        metadata: { peragus_onboarding_test: "true" } };
      const context = { id: randomUUID(), customerId, draftVersion, termsSessionId };
      record = await this.repository.reserve({ ...context,
        requestHash: this.vault.hash(context, payload), idempotencyKey: `peragus-registration-test-${customerId}`,
        encryptedPayload: this.vault.seal(context, payload), state: "pending", providerId: null, providerStatus: null,
        verificationMode: null, snapshot: null, snapshotVersion: 0, refreshedAt: null });
      if (record.state === "linked") return { data: submissionView(record), replayed: true };
    }
    // Retry the frozen request, not a subsequently edited draft or renewed terms token.
    const context = { id: record.id, customerId, draftVersion: record.draftVersion, termsSessionId: record.termsSessionId };
    const payload = this.vault.open(context, record.encryptedPayload) as OzavRegistrationPayload;
    if (this.vault.hash(context, payload) !== record.requestHash) throw new SubmissionError("ONBOARDING_CONFLICT");
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== "test" || !["customers", "custody"].every(value => caps.entitlements.includes(value))
      || !caps.scopes.includes("customers:write")) throw new SubmissionError("ONBOARDING_CAPABILITY_REQUIRED");
    const result = await this.provider.createOnboardingCustomer(payload, record.idempotencyKey);
    if (result.externalRef !== payload.external_ref || result.email !== payload.email || result.verificationMode !== "full") throw new SubmissionError("ONBOARDING_CONFLICT");
    return { data: submissionView(await this.repository.complete(record, result)), replayed: false };
  }
}
