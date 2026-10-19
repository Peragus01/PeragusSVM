import type { Customer } from "../auth/customer-access.js";
import type { OzavVerification } from "../providers/ozav-client.js";
import type { TermsState } from "./terms-types.js";
export interface OverviewFacts {
  binding_consistent: boolean;
  draft: { version: number; updated_at: string } | null;
  terms: { session_id: string; state: TermsState; version: string | null; expires_at: string | null; accepted_at: string | null; active: boolean } | null;
  registration: { state: "pending" | "linked"; draft_version: number; provider_status: string | null;
    verification_mode: string | null; requirements_pending: boolean | null; due_count: number | null;
    missing_fields_count: number | null; documents_due_count: number | null; refreshed_at: string | null } | null;
  identity: { status: OzavVerification["status"] | null; checks: OzavVerification["checks"]; refreshed_at: string | null } | null;
  screening: { status: string | null; result: string | null; lists: string[] | null; matches_count: number | null;
    suggested_decision: string | null; refreshed_at: string | null } | null;
}
export interface OnboardingOverviewRepository { read(customerId: string): Promise<OverviewFacts>; }
export interface OnboardingActions {
  draft: boolean; terms: boolean; submission: boolean; verification: boolean; screening: boolean;
}
const captureChecks = ["kyc_document", "liveness", "face_match"] as const;
const allowedChecks = [...captureChecks,"aml_name_screening"] as const;
export class CustomerOnboardingOverview {
  constructor(private readonly repository: OnboardingOverviewRepository, private readonly actions: OnboardingActions,
    private readonly now: () => Date = () => new Date()) {}
  async read(customer: Customer) {
    const facts = await this.repository.read(customer.id);
    if (!facts.binding_consistent) throw new Error("ONBOARDING_EVIDENCE_CONFLICT");
    const checks: OzavVerification["checks"] = {};
    for (const key of allowedChecks) {
      const value = facts.identity?.checks?.[key];
      if (value && ["pass","fail","review","pending","not_started"].includes(value)) checks[key]=value;
    }
    const identityOutcome = facts.identity?.status !== "completed" ? null
      : captureChecks.every(k=>checks[k]==="pass") ? "approved"
      : captureChecks.some(k=>checks[k]==="fail") ? "rejected" : null;
    const allChecksOutcome = facts.identity?.status !== "completed" ? null
      : allowedChecks.every(k=>checks[k]==="pass") ? "approved"
      : allowedChecks.some(k=>checks[k]==="fail") ? "rejected" : null;
    const linked = facts.registration?.state === "linked";
    const terms = facts.terms;
    const expired = terms?.expires_at != null && Date.parse(terms.expires_at) <= this.now().getTime();
    const pending: string[] = [];
    if (!facts.draft) pending.push("INDIVIDUAL_DRAFT_REQUIRED");
    if (!terms) pending.push("PROVIDER_TERMS_REQUIRED");
    else if (terms.state !== "accepted" || !terms.accepted_at) pending.push(
      terms.state === "uncertain" ? "PROVIDER_TERMS_RECOVERY_REQUIRED" : "PROVIDER_TERMS_ACCEPTANCE_REQUIRED");
    else if (!linked && (expired || !terms.active)) pending.push("PROVIDER_TERMS_RENEWAL_REQUIRED");
    if (!facts.registration) pending.push("PROVIDER_SUBMISSION_REQUIRED");
    else if (!linked) pending.push("PROVIDER_SUBMISSION_PENDING");
    if (linked) {
      if (facts.registration?.provider_status !== "approved") pending.push("PROVIDER_STATUS_NOT_APPROVED");
      if (facts.registration?.verification_mode !== "full") pending.push("PROVIDER_VERIFICATION_MODE_REVIEW_REQUIRED");
      if (!facts.identity) pending.push("IDENTITY_VERIFICATION_REQUIRED");
      else if (identityOutcome === "rejected") pending.push("IDENTITY_VERIFICATION_REJECTED");
      else if (identityOutcome !== "approved") pending.push("IDENTITY_VERIFICATION_PENDING");
      if (!facts.screening) pending.push("SCREENING_REQUIRED");
      else if (facts.screening.status !== "completed") pending.push("SCREENING_PENDING");
      else if (facts.screening.result !== "clear" || facts.screening.matches_count !== 0
        || facts.screening.suggested_decision !== "clear") pending.push("SCREENING_REVIEW_REQUIRED");
      if (facts.registration?.requirements_pending === true) pending.push("PROVIDER_REQUIREMENTS_PENDING");
      else if (facts.registration?.requirements_pending == null) pending.push("PROVIDER_REQUIREMENTS_UNKNOWN");
    }
    return {
      customer: { id: customer.id, type: customer.type, verification_status: customer.verificationStatus },
      environment: "test", sandbox_only: true, source: "stored_observations", checked_at: this.now().toISOString(),
      draft: facts.draft ? { version: facts.draft.version, updated_at: facts.draft.updated_at,
        matches_submitted_version: facts.registration ? facts.draft.version===facts.registration.draft_version : null } : null,
      provider_terms: terms ? { session_id: terms.session_id, state: terms.state, version: terms.version,
        expires_at: terms.expires_at, expired, accepted_at: terms.accepted_at, active: terms.active,
        linked_to_submission: facts.registration !== null } : null,
      registration: facts.registration ? { state: facts.registration.state, draft_version: facts.registration.draft_version,
        provider_status: facts.registration.provider_status, verification_mode: facts.registration.verification_mode,
        requirements_pending: facts.registration.requirements_pending, due_count: facts.registration.due_count,
        missing_fields_count: facts.registration.missing_fields_count, documents_due_count: facts.registration.documents_due_count,
        refreshed_at: facts.registration.refreshed_at } : null,
      identity: facts.identity ? { status: facts.identity.status, checks, identity_outcome: identityOutcome,
        all_checks_outcome: allChecksOutcome, refreshed_at: facts.identity.refreshed_at } : null,
      screening: facts.screening ? { status: facts.screening.status, result: facts.screening.result,
        lists: facts.screening.lists, matches_count: facts.screening.matches_count,
        suggested_decision: facts.screening.suggested_decision, refreshed_at: facts.screening.refreshed_at } : null,
      pending_steps: pending, actions_enabled: { ...this.actions },
      observation_freshness: "not_evaluated", operations_enabled: false,
      operation_blockers: ["SANDBOX_ONLY", "FINANCIAL_OPERATIONS_DISABLED"],
    };
  }
}
