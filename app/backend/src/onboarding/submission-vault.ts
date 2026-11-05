import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
const envelope = z.object({ schema: z.literal(1), key_id: z.string(), iv: z.string().max(24), tag: z.string().max(32), ciphertext: z.string().min(1).max(24000) }).strict();
export interface SubmissionContext { id: string; customerId: string; draftVersion: number; termsSessionId: string; }
function decode(value: string, size?: number) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size)) throw new Error("Invalid protected submission");
  return bytes;
}
export class SubmissionVault {
  private readonly key: Buffer; private readonly hashKey: Buffer;
  constructor(key: string, private readonly keyId: string) {
    this.key = decode(key, 32);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) throw new Error("Invalid submission key ID");
    this.hashKey = Buffer.from(hkdfSync("sha256", this.key, Buffer.alloc(0), "peragus-registration-request-hmac-v1", 32));
  }
  private aad(c: SubmissionContext) {
    return Buffer.from(JSON.stringify({ purpose: "peragus-registration", environment: "test", schema: 1, keyId: this.keyId,
      id: c.id, customerId: c.customerId, draftVersion: c.draftVersion, termsSessionId: c.termsSessionId }));
  }
  hash(c: SubmissionContext, payload: unknown) {
    return createHmac("sha256", this.hashKey).update(JSON.stringify({ customerId: c.customerId, draftVersion: c.draftVersion, termsSessionId: c.termsSessionId, payload })).digest("hex");
  }
  seal(c: SubmissionContext, payload: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv); cipher.setAAD(this.aad(c));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return { schema: 1 as const, key_id: this.keyId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  open(c: SubmissionContext, value: unknown): unknown {
    const e = envelope.parse(value);
    if (e.key_id !== this.keyId) throw new Error("Submission key unavailable");
    const decipher = createDecipheriv("aes-256-gcm", this.key, decode(e.iv, 12));
    decipher.setAAD(this.aad(c)); decipher.setAuthTag(decode(e.tag, 16));
    return JSON.parse(Buffer.concat([decipher.update(decode(e.ciphertext)), decipher.final()]).toString("utf8"));
  }
}
