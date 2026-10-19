import { z } from "zod";
import type { OzavClient, OzavTermsEvidence, OzavTermsSession } from "../providers/ozav-client.js";
import type { IndividualDraftService } from "./individual-draft-service.js";
import { TermsFlowError, type TermsRecord, type TermsRepository } from "./terms-types.js";
import { TermsVault, type TermsContext } from "./terms-vault.js";
const evidenceSchema = z.object({ accepted_by: z.object({ legal_name: z.string().min(2).max(160) }).strict(), accepted_at: z.string().datetime() }).strict();
const tokenSchema = z.object({ token: z.string().regex(/^ts_[A-Za-z0-9_-]{8,256}$/) }).strict();
export class CustomerTermsService {
  constructor(private readonly repository: TermsRepository, private readonly vault: TermsVault,
    private readonly provider: Pick<OzavClient, "getCustomerCapabilities" | "createCustomerTerms" | "acceptCustomerTerms">,
    private readonly drafts: Pick<IndividualDraftService, "read">, private readonly now: () => Date = () => new Date()) {}
  private context(row: TermsRecord): TermsContext {
    if (!row.termsUrl || !row.termsVersion || !row.expiresAt) throw new TermsFlowError("TERMS_RESPONSE_CONFLICT");
    return { id: row.id, customerId: row.customerId, termsUrl: row.termsUrl, termsVersion: row.termsVersion, expiresAt: row.expiresAt };
  }
  private token(row: TermsRecord): string {
    return tokenSchema.parse(this.vault.open(this.context(row), "token", row.encryptedToken)).token;
  }
  private view(row: TermsRecord) {
    if (row.encryptedToken !== null) this.token(row); // Verify context integrity before presenting the stored terms.
    const expired = row.expiresAt !== null && Date.parse(row.expiresAt) <= this.now().getTime();
    return { session_id: row.id, state: row.state, terms_url: row.termsUrl, terms_version: row.termsVersion,
      expires_at: row.expiresAt, expired, accepted_at: row.acceptedAt,
      can_accept: row.state === "ready" && !expired,
      can_renew: row.state === "uncertain" || (expired && row.state !== "accepting"),
      environment: "test", operations_enabled: false };
  }
  private async capabilities() {
    const caps = await this.provider.getCustomerCapabilities();
    if (caps.environment !== "test" || !caps.entitlements.includes("customers") || !caps.scopes.includes("customers:write")) throw new TermsFlowError("TERMS_CAPABILITY_REQUIRED");
  }
  async read(customerId: string) {
    const row = await this.repository.findActive(customerId);
    return row ? this.view(row) : null;
  }
  async start(customerId: string, renewId?: string) {
    const { record, claimed } = await this.repository.reserve(customerId, renewId, this.now());
    if (!claimed) {
      if (record.state === "creating" || record.state === "accepting") throw new TermsFlowError("TERMS_PROCESSING");
      if (record.state === "uncertain") throw new TermsFlowError("TERMS_RECOVERY_REQUIRED");
      if (record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime()) throw new TermsFlowError("TERMS_SESSION_EXPIRED");
      return { data: this.view(record), created: false };
    }
    await this.capabilities();
    const session = await this.provider.createCustomerTerms(record.idempotencyKey);
    if (!session.token) {
      await this.repository.markUncertain(record);
      throw new TermsFlowError("TERMS_RECOVERY_REQUIRED");
    }
    if (session.status !== "pending" || Date.parse(session.expiresAt) <= this.now().getTime()) throw new TermsFlowError("TERMS_RESPONSE_CONFLICT");
    const context = { id: record.id, customerId, termsUrl: session.url, termsVersion: session.version, expiresAt: session.expiresAt };
    const row = await this.repository.completeCreation(record, { token: this.vault.seal(context, "token", { token: session.token }),
      url: session.url, version: session.version, expiresAt: session.expiresAt });
    return { data: this.view(row), created: true };
  }
  // Internal capability only; never return this token through an HTTP handler.
  async resolveForSubmission(customerId: string, sessionId: string, legalName: string): Promise<string> {
    const row = await this.repository.findOwned(customerId, sessionId);
    if (!row || !row.active || row.state !== "accepted") throw new TermsFlowError("TERMS_SESSION_NOT_FOUND");
    if (!row.expiresAt || Date.parse(row.expiresAt) <= this.now().getTime()) throw new TermsFlowError("TERMS_SESSION_EXPIRED");
    const evidence = evidenceSchema.parse(this.vault.open(this.context(row), "acceptance", row.encryptedAcceptance));
    if (evidence.accepted_by.legal_name !== legalName || evidence.accepted_at !== row.acceptedAt) throw new TermsFlowError("TERMS_RESPONSE_CONFLICT");
    return this.token(row);
  }
  private matches(row: TermsRecord, response: OzavTermsSession, evidence: OzavTermsEvidence) {
    return response.token === null && response.status === "accepted" && response.url === row.termsUrl && response.version === row.termsVersion
      && response.expiresAt === row.expiresAt && response.acceptedAt === evidence.accepted_at;
  }
  async accept(customerId: string, sessionId: string) {
    let row = await this.repository.findOwned(customerId, sessionId);
    if (!row) throw new TermsFlowError("TERMS_SESSION_NOT_FOUND");
    if (!row.active) throw new TermsFlowError("TERMS_SESSION_CONFLICT");
    if (row.state === "accepted") return this.view(row);
    if (row.state !== "ready" && row.state !== "accepting") throw new TermsFlowError("TERMS_PROCESSING");
    if (row.state === "ready" && row.expiresAt && Date.parse(row.expiresAt) <= this.now().getTime()) throw new TermsFlowError("TERMS_SESSION_EXPIRED");
    let evidence: OzavTermsEvidence;
    if (row.state === "ready") {
      const draft = await this.drafts.read(customerId);
      if (!draft) throw new TermsFlowError("TERMS_PROFILE_REQUIRED");
      // Synthetic staging identity only. Do not invent email, IP, user-agent or acceptance for the person.
      evidence = { accepted_by: { legal_name: draft.individual.legal_name }, accepted_at: this.now().toISOString() };
    } else {
      evidence = evidenceSchema.parse(this.vault.open(this.context(row), "acceptance", row.encryptedAcceptance));
    }
    const token = this.token(row);
    await this.capabilities();
    row = await this.repository.claimAcceptance(row, this.vault.seal(this.context(row), "acceptance", evidence), this.now());
    // Retry uses the frozen first evidence even if the draft was edited in another tab.
    evidence = evidenceSchema.parse(this.vault.open(this.context(row), "acceptance", row.encryptedAcceptance));
    const response = await this.provider.acceptCustomerTerms(token, evidence);
    if (!this.matches(row, response, evidence)) throw new TermsFlowError("TERMS_RESPONSE_CONFLICT");
    return this.view(await this.repository.completeAcceptance(row, evidence.accepted_at));
  }
}
