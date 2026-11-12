import type { OzavCustomerSnapshot } from "../providers/ozav-client.js";
import type { MoneyMode } from "../config/money-environment.js";
/** What the person confirmed when submitting: synthetic test data, or (live) that the data are theirs and true. */
export type SubmissionAttestation = "sandbox_data_confirmed" | "data_truthfulness_confirmed";
export const attestationFor = (mode: MoneyMode): SubmissionAttestation => mode === "live" ? "data_truthfulness_confirmed" : "sandbox_data_confirmed";
export interface SubmissionRecord {
  id: string; customerId: string; draftVersion: number; termsSessionId: string;
  requestHash: string; idempotencyKey: string; encryptedPayload: unknown;
  state: "pending" | "linked"; providerId: string | null; providerStatus: string | null;
  verificationMode: "full" | "reliance" | null; snapshot: OzavCustomerSnapshot | null;
  snapshotVersion: number; refreshedAt: string | null;
  /** Recorded with the reservation; null only on rows created before attestations were stored. */
  attestation?: SubmissionAttestation | null;
}
export class SubmissionError extends Error {
  constructor(public readonly code: "ONBOARDING_CONFLICT" | "ONBOARDING_DRAFT_REQUIRED" | "ONBOARDING_DRAFT_CHANGED" | "ONBOARDING_CAPABILITY_REQUIRED" | "ONBOARDING_NOT_SUBMITTED" | "ONBOARDING_ATTESTATION_REQUIRED" | "ONBOARDING_EMAIL_REQUIRED") { super(code); }
}
export interface SubmissionRepository {
  find(customerId: string): Promise<SubmissionRecord | null>;
  reserve(record: SubmissionRecord): Promise<SubmissionRecord>;
  complete(record: SubmissionRecord, result: { id: string; status: string; verificationMode: "full" }): Promise<SubmissionRecord>;
  saveSnapshot(customerId: string, providerId: string, version: number, snapshot: OzavCustomerSnapshot): Promise<SubmissionRecord>;
}
/** OZAV external_ref of the registration. Test refs are marked synthetic; live refs are not. */
export const onboardingExternalRef = (customerId: string, mode: MoneyMode) =>
  mode === "live" ? `peragus-onboarding:${customerId}` : `peragus-onboarding-test:${customerId}`;
/** Idempotency key of the registration POST, derived from the mode like the external_ref. */
export const onboardingIdempotencyKey = (customerId: string, mode: MoneyMode) =>
  mode === "live" ? `peragus-registration-${customerId}` : `peragus-registration-test-${customerId}`;
