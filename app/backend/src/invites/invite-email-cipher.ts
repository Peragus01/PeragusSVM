import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const envelope = z
  .object({
    version: z.literal(1),
    key_id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    iv: z.string().max(24),
    tag: z.string().max(24),
    ciphertext: z.string().max(100000),
  })
  .strict();
const payload = z
  .object({
    email: z.email().max(254),
    code: z.string().regex(/^pginv_[A-Za-z0-9_-]{43}$/),
    message: z.string().max(64000).optional(),
  })
  .strict();
function decode(value: string, size?: number): Buffer {
  const b = Buffer.from(value, "base64");
  if (
    b.toString("base64") !== value ||
    (size !== undefined && b.length !== size)
  )
    throw new Error("INVITE_EMAIL_CIPHER_INVALID");
  return b;
}
export class InviteEmailCipher {
  private readonly key: Buffer;
  constructor(
    key: string,
    private readonly keyId: string,
  ) {
    this.key = decode(key, 32);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId))
      throw new Error("INVITE_EMAIL_CIPHER_INVALID");
  }
  private aad(inviteId: string) {
    return Buffer.from(
      JSON.stringify({
        purpose: "peragus-invite-email",
        environment: "test",
        inviteId,
        version: 1,
        keyId: this.keyId,
      }),
    );
  }
  seal(inviteId: string, value: z.infer<typeof payload>) {
    const data = payload.parse(value),
      iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(inviteId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(data), "utf8"),
      cipher.final(),
    ]);
    return {
      version: 1,
      key_id: this.keyId,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }
  open(inviteId: string, input: unknown) {
    const data = envelope.parse(input);
    if (data.key_id !== this.keyId)
      throw new Error("INVITE_EMAIL_KEY_UNAVAILABLE");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      decode(data.iv, 12),
    );
    decipher.setAAD(this.aad(inviteId));
    decipher.setAuthTag(decode(data.tag, 16));
    return payload.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(decode(data.ciphertext)),
          decipher.final(),
        ]).toString("utf8"),
      ),
    );
  }
}
