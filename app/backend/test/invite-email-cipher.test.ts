import { describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { InviteEmailCipher } from "../src/invites/invite-email-cipher.js";

describe("invitation email encryption", () => {
  it("binds encrypted recipient and code to the invite and rejects tampering", () => {
    const cipher = new InviteEmailCipher(
        randomBytes(32).toString("base64"),
        "v1",
      ),
      id = randomUUID();
    const payload = {
      email: "synthetic@example.test",
      code: "pginv_" + "a".repeat(43),
    };
    const sealed = cipher.seal(id, payload);
    expect(JSON.stringify(sealed)).not.toContain(payload.email);
    expect(JSON.stringify(sealed)).not.toContain(payload.code);
    expect(cipher.open(id, sealed)).toEqual(payload);
    expect(() => cipher.open(randomUUID(), sealed)).toThrow();
    expect(() =>
      cipher.open(id, { ...sealed, tag: Buffer.alloc(16).toString("base64") }),
    ).toThrow();
    expect(() =>
      new InviteEmailCipher(randomBytes(32).toString("base64"), "v2").open(
        id,
        sealed,
      ),
    ).toThrow();
  });
});
