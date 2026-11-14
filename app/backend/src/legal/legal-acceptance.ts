import { isIP } from "node:net";
import { z } from "zod";

export const LEGAL_DOCUMENTS = ["terms", "privacy", "refund"] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

export interface RequiredLegalDocument {
  document: LegalDocument;
  version: string;
  sha256: string;
}
export interface LegalEvidence {
  userId: string;
  customerId: string;
  ip: string | null;
  userAgent: string | null;
}
export interface LegalAcceptanceRepository {
  listAccepted(customerId: string): Promise<RequiredLegalDocument[]>;
  /** Append-only and atomic; replaying an identical acceptance is a no-op. */
  record(
    evidence: LegalEvidence,
    documents: RequiredLegalDocument[],
  ): Promise<void>;
}
export class LegalAcceptanceError extends Error {
  constructor(public readonly code: "LEGAL_VERSION_MISMATCH") {
    super(code);
  }
}

const entry = z
  .object({
    version: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^\x00-\x1f\x7f]+$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const requiredSchema = z
  .object({ terms: entry, privacy: entry, refund: entry })
  .strict();

/** Strict parse of LEGAL_REQUIRED_DOCUMENTS; throws on any deviation. */
export function parseLegalRequiredDocuments(
  raw: string,
): RequiredLegalDocument[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("LEGAL_REQUIRED_DOCUMENTS_INVALID");
  }
  const parsed = requiredSchema.safeParse(json);
  if (!parsed.success) throw new Error("LEGAL_REQUIRED_DOCUMENTS_INVALID");
  return LEGAL_DOCUMENTS.map((document) => ({
    document,
    version: parsed.data[document].version,
    sha256: parsed.data[document].sha256,
  }));
}

const MAX_USER_AGENT = 512;
export function sanitizeUserAgent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_USER_AGENT);
  return clean.length ? clean : null;
}
/** The address Fastify already resolved for the request; null if it is not a valid IP. */
export function sanitizeIp(value: unknown): string | null {
  return typeof value === "string" && isIP(value) ? value : null;
}

export class LegalAcceptanceService {
  private readonly required: RequiredLegalDocument[];
  constructor(
    required: RequiredLegalDocument[],
    private readonly repository: LegalAcceptanceRepository,
  ) {
    if (
      required.length !== LEGAL_DOCUMENTS.length ||
      !LEGAL_DOCUMENTS.every((d) => required.some((r) => r.document === d))
    )
      throw new Error("LEGAL_REQUIRED_DOCUMENTS_INVALID");
    this.required = required.map((r) => ({ ...r }));
  }
  requiredDocuments(): RequiredLegalDocument[] {
    return this.required.map((r) => ({ ...r }));
  }
  /** Required documents without an acceptance of the exact version and hash. */
  async missing(customerId: string): Promise<RequiredLegalDocument[]> {
    const accepted = await this.repository.listAccepted(customerId);
    return this.required
      .filter(
        (r) =>
          !accepted.some(
            (a) =>
              a.document === r.document &&
              a.version === r.version &&
              a.sha256 === r.sha256,
          ),
      )
      .map((r) => ({ ...r }));
  }
  async status(customerId: string) {
    return {
      required: this.requiredDocuments(),
      missing: await this.missing(customerId),
    };
  }
  /**
   * Records only versions equal to the required ones (the hash comes from the server
   * configuration, never from the client). All-or-nothing.
   */
  async accept(
    evidence: LegalEvidence,
    submitted: { document: LegalDocument; version: string }[],
  ) {
    const chosen: RequiredLegalDocument[] = [];
    for (const item of submitted) {
      const required = this.required.find((r) => r.document === item.document);
      if (!required || required.version !== item.version)
        throw new LegalAcceptanceError("LEGAL_VERSION_MISMATCH");
      if (!chosen.some((c) => c.document === item.document))
        chosen.push(required);
    }
    await this.repository.record(evidence, chosen);
    return this.status(evidence.customerId);
  }
}
