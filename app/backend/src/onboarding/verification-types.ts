import type { OzavVerification } from "../providers/ozav-client.js";
export const verificationChecks = ["kyc_document", "liveness", "face_match", "aml_name_screening"] as const;
export type VerificationCheck = typeof verificationChecks[number];
export type SimulationOutcome = "approved" | "rejected";
export interface VerificationRecord {
  customerId: string; providerCustomerId: string; verificationId: string | null;
  createAttempted: boolean; observation: OzavVerification | null; revision: number;
  refreshedAt: string | null; lastSimulatedOutcome: SimulationOutcome | null;
  /** Verifications this customer already ended (expired); never recovered again. */
  previousVerificationIds?: string[];
}
export class VerificationError extends Error {
  constructor(public readonly code: "VERIFICATION_CUSTOMER_REQUIRED" | "VERIFICATION_FULL_MODE_REQUIRED" | "VERIFICATION_CAPABILITY_REQUIRED" | "VERIFICATION_PROCESSING" | "VERIFICATION_RECOVERY_REQUIRED" | "VERIFICATION_NOT_STARTED" | "VERIFICATION_CONFLICT" | "VERIFICATION_OUTCOME_MISMATCH" | "VERIFICATION_SESSION_UNAVAILABLE" | "VERIFICATION_SIMULATION_UNAVAILABLE") { super(code); }
}
export interface VerificationRepository {
  find(customerId: string): Promise<VerificationRecord | null>;
  reserve(customerId: string, providerCustomerId: string): Promise<VerificationRecord>;
  claimCreate(customerId: string): Promise<boolean>;
  /**
   * Undo claimCreate when no session exists (no verification linked yet). With `olderThanMs`
   * only a claim older than that is released. True when a claim was released.
   */
  releaseCreate(customerId: string, olderThanMs?: number): Promise<boolean>;
  /** The linked verification ended (expired): unlink it, keeping its id as history, so a new one may start. */
  resetEnded(customerId: string, verificationId: string): Promise<void>;
  save(record: VerificationRecord, observation: OzavVerification, outcome?: SimulationOutcome): Promise<VerificationRecord>;
}
