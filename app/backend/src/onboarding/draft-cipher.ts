import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { IndividualDraft } from "./individual-schema.js";
const envelopeSchema = z.object({ schema: z.literal(1), key_id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  iv: z.string().max(24), tag: z.string().max(32), ciphertext: z.string().min(1).max(24_000),
}).strict();
export type EncryptedDraft = z.infer<typeof envelopeSchema>;
function decode(value: string, size?: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size)) throw new Error("Invalid encrypted draft");
  return bytes;
}
export class DraftCipher {
  private readonly key: Buffer;
  constructor(keyBase64: string, private readonly keyId: string) {
    this.key = decode(keyBase64, 32);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) throw new Error("Invalid draft key ID");
  }
  private aad(customerId: string, version: number) {
    return Buffer.from(JSON.stringify({ purpose: "peragus-individual-draft", environment: "test", customerId, version, schema: 1, keyId: this.keyId }));
  }
  encrypt(customerId: string, version: number, individual: IndividualDraft): EncryptedDraft {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(customerId, version));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(individual), "utf8"), cipher.final()]);
    return { schema: 1, key_id: this.keyId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }
  decrypt(customerId: string, version: number, input: unknown): unknown {
    const e = envelopeSchema.parse(input);
    if (e.key_id !== this.keyId) throw new Error("Draft key unavailable");
    const decipher = createDecipheriv("aes-256-gcm", this.key, decode(e.iv, 12));
    decipher.setAAD(this.aad(customerId, version));
    decipher.setAuthTag(decode(e.tag, 16));
    return JSON.parse(Buffer.concat([decipher.update(decode(e.ciphertext)), decipher.final()]).toString("utf8"));
  }
}
