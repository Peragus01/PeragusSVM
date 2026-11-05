import type { OzavCustomerSnapshot } from "../providers/ozav-client.js";
export interface SubmissionRecord {
  id: string; customerId: string; draftVersion: number; termsSessionId: string;
  requestHash: string; idempotencyKey: string; encryptedPayload: unknown;
  state: "pending" | "linked"; providerId: string | null; providerStatus: string | null;
  verificationMode: "full" | "reliance" | null; snapshot: OzavCustomerSnapshot | null;
  snapshotVersion: number; refreshedAt: string | null;
}
export class SubmissionError extends Error {
  constructor(public readonly code: "ONBOARDING_CONFLICT" | "ONBOARDING_DRAFT_REQUIRED" | "ONBOARDING_DRAFT_CHANGED" | "ONBOARDING_CAPABILITY_REQUIRED" | "ONBOARDING_NOT_SUBMITTED") { super(code); }
}
export interface SubmissionRepository {
  find(customerId: string): Promise<SubmissionRecord | null>;
  reserve(record: SubmissionRecord): Promise<SubmissionRecord>;
  complete(record: SubmissionRecord, result: { id: string; status: string; verificationMode: "full" }): Promise<SubmissionRecord>;
  saveSnapshot(customerId: string, providerId: string, version: number, snapshot: OzavCustomerSnapshot): Promise<SubmissionRecord>;
}
export const onboardingExternalRef = (customerId: string) => `peragus-onboarding-test:${customerId}`;
