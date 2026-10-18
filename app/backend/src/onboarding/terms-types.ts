import type { TermsEnvelope } from "./terms-vault.js";
export type TermsState = "creating" | "ready" | "accepting" | "accepted" | "uncertain";
export interface TermsRecord {
  id: string; customerId: string; active: boolean; state: TermsState; generation: number;
  idempotencyKey: string; leaseUntil: string; encryptedToken: unknown;
  termsUrl: string | null; termsVersion: string | null; expiresAt: string | null;
  encryptedAcceptance: unknown; acceptedAt: string | null;
}
export class TermsFlowError extends Error {
  constructor(public readonly code: "TERMS_SESSION_CONFLICT" | "TERMS_SESSION_NOT_FOUND" | "TERMS_SESSION_EXPIRED" | "TERMS_PROCESSING" | "TERMS_RECOVERY_REQUIRED" | "TERMS_PROFILE_REQUIRED" | "TERMS_CAPABILITY_REQUIRED" | "TERMS_RESPONSE_CONFLICT") { super(code); }
}
export interface TermsRepository {
  findActive(customerId: string): Promise<TermsRecord | null>;
  findOwned(customerId: string, id: string): Promise<TermsRecord | null>;
  reserve(customerId: string, renewId: string | undefined, now: Date): Promise<{ record: TermsRecord; claimed: boolean }>;
  completeCreation(record: TermsRecord, result: { token: TermsEnvelope; url: string; version: string; expiresAt: string }): Promise<TermsRecord>;
  markUncertain(record: TermsRecord): Promise<void>;
  claimAcceptance(record: TermsRecord, evidence: TermsEnvelope, now: Date): Promise<TermsRecord>;
  completeAcceptance(record: TermsRecord, acceptedAt: string): Promise<TermsRecord>;
}
