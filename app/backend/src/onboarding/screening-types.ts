import type { OzavScreening } from "../providers/ozav-client.js";
export interface ScreeningRecord {
  customerId: string; providerCustomerId: string; idempotencyKey: string; screeningId: string | null;
  observation: OzavScreening | null; revision: number; refreshedAt: string | null;
}
export class ScreeningError extends Error {
  constructor(public readonly code: "SCREENING_CUSTOMER_REQUIRED" | "SCREENING_CAPABILITY_REQUIRED" | "SCREENING_CONFLICT" | "SCREENING_RECONCILIATION_REQUIRED" | "SCREENING_NOT_STARTED") { super(code); }
}
export interface ScreeningRepository {
  find(customerId: string): Promise<ScreeningRecord | null>;
  reserve(customerId: string, providerCustomerId: string): Promise<ScreeningRecord>;
  save(row: ScreeningRecord, observation: OzavScreening): Promise<ScreeningRecord>;
}
