import type { IndividualDraftRepository } from "../repositories/postgres-individual-draft.js";
import { DraftVersionConflict } from "../repositories/postgres-individual-draft.js";
import type { DraftCipher } from "./draft-cipher.js";
import { individualDraftSchema, type IndividualDraft } from "./individual-schema.js";
export class IndividualDraftService {
  constructor(private readonly repository: IndividualDraftRepository, private readonly cipher: DraftCipher) {}
  async read(customerId: string) {
    const stored = await this.repository.find(customerId);
    if (!stored) return null;
    const individual = individualDraftSchema().parse(this.cipher.decrypt(customerId, stored.version, stored.encrypted));
    return { individual, version: stored.version, updated_at: stored.updatedAt };
  }
  async save(customerId: string, expectedVersion: number, individual: IndividualDraft) {
    if (expectedVersion > 0) {
      const prior = await this.repository.find(customerId);
      if (!prior || prior.version !== expectedVersion) throw new DraftVersionConflict();
      // Key loss or tampering cannot silently overwrite an unreadable prior draft.
      this.cipher.decrypt(customerId, prior.version, prior.encrypted);
    }
    const encrypted = this.cipher.encrypt(customerId, expectedVersion + 1, individual);
    const stored = await this.repository.save(customerId, expectedVersion, encrypted);
    return { individual, version: stored.version, updated_at: stored.updatedAt };
  }
}
