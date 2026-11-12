import type { LegalAcceptanceService } from "../../src/legal/legal-acceptance.js";

/**
 * Explicit test double for suites that do not exercise the legal flow: every
 * customer has accepted every required document. The real gate is covered by
 * test/legal-acceptance.test.ts.
 */
export const allAcceptedLegal = {
  requiredDocuments: () => [],
  missing: async () => [],
  status: async () => ({ required: [], missing: [] }),
  accept: async () => ({ required: [], missing: [] }),
} as unknown as LegalAcceptanceService;
