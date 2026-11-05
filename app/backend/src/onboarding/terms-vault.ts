import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
const envelope = z.object({ schema: z.literal(1), key_id: z.string(), iv: z.string().max(24), tag: z.string().max(32), ciphertext: z.string().max(16000) }).strict();
export type TermsEnvelope = z.infer<typeof envelope>;
export interface TermsContext { id: string; customerId: string; termsUrl: string; termsVersion: string; expiresAt: string; }
function decode(value: string, size?: number) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size)) throw new Error("Invalid protected terms data");
  return bytes;
}
export class TermsVault {
  private readonly key: Buffer;
  constructor(key: string, private readonly keyId: string) {
    this.key = decode(key, 32);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) throw new Error("Invalid terms key ID");
  }
  private aad(context: TermsContext, purpose: "token" | "acceptance") {
    return Buffer.from(JSON.stringify({ namespace: "peragus-terms", environment: "test", schema: 1, keyId: this.keyId, purpose, id: context.id, customerId: context.customerId, termsUrl: context.termsUrl, termsVersion: context.termsVersion, expiresAt: context.expiresAt }));
  }
  seal(context: TermsContext, purpose: "token" | "acceptance", value: unknown): TermsEnvelope {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(context, purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { schema: 1, key_id: this.keyId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }
  open(context: TermsContext, purpose: "token" | "acceptance", input: unknown): unknown {
    const e = envelope.parse(input);
    if (e.key_id !== this.keyId) throw new Error("Terms key unavailable");
    const decipher = createDecipheriv("aes-256-gcm", this.key, decode(e.iv, 12));
    decipher.setAAD(this.aad(context, purpose)); decipher.setAuthTag(decode(e.tag, 16));
    return JSON.parse(Buffer.concat([decipher.update(decode(e.ciphertext)), decipher.final()]).toString("utf8"));
  }
}
