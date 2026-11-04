import { createHmac, randomBytes } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  InviteEmailDelivery,
  verifyInviteDelivery,
} from "../src/invites/invite-email-delivery.js";
import { InviteEmailProvider } from "../src/invites/invite-email-provider.js";
const key = randomBytes(32),
  secret = "whsec_" + key.toString("base64"),
  now = Date.now(),
  ts = String(Math.floor(now / 1000)),
  id = "msg_synthetic_invite_event";
const payload = {
  type: "email.delivered",
  data: {
    email_id: "synthetic-provider-id",
    subject: "[TESTES] Seu convite para a Peragus",
    to: ["synthetic@example.test"],
  },
};
function sign(body: string, time = ts) {
  return {
    "svix-id": id,
    "svix-timestamp": time,
    "svix-signature":
      "v1," +
      createHmac("sha256", key)
        .update(`${id}.${time}.${body}`)
        .digest("base64"),
  };
}
describe("signed invitation delivery", () => {
  it("matches the published Svix manual-verification vector", () => {
    expect(
      verifyInviteDelivery(
        Buffer.from('{"event_type":"ping","data":{"success":true}}'),
        {
          "svix-id": "msg_loFOjxBNrRLzqYUf",
          "svix-timestamp": "1731705121",
          "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
        },
        "whsec_plJ3nmyCDGBKInavdOK15jsl",
        1731705121000,
      ),
    ).toBe(true);
  });
  it("verifies exact original bytes and rejects timestamp/header tampering", () => {
    const raw = JSON.stringify(payload),
      headers = sign(raw);
    expect(verifyInviteDelivery(Buffer.from(raw), headers, secret, now)).toBe(
      true,
    );
    expect(
      verifyInviteDelivery(Buffer.from(raw + " "), headers, secret, now),
    ).toBe(false);
    expect(
      verifyInviteDelivery(
        Buffer.from(raw),
        { ...headers, "svix-id": "msg_other" },
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      verifyInviteDelivery(
        Buffer.from(raw),
        sign(raw, String(Number(ts) - 301)),
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      verifyInviteDelivery(
        Buffer.from(raw),
        sign(raw, String(Number(ts) + 301)),
        secret,
        now,
      ),
    ).toBe(false);
    expect(verifyInviteDelivery(Buffer.from(raw), {}, secret, now)).toBe(false);
    expect(
      verifyInviteDelivery(Buffer.from(raw), headers, "whsec_invalid", now),
    ).toBe(false);
  });
  it("isolates raw parsing, fails closed, asks for early-event retry and never exposes payloads", async () => {
    const receive = vi.fn().mockResolvedValue("recorded"),
      service = { receive } as unknown as InviteEmailDelivery;
    const app = await buildApp({
      inviteDelivery: { secret, service, now: () => now },
    });
    const raw = JSON.stringify(payload),
      headers = { "content-type": "application/json", ...sign(raw) };
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/webhooks/invitation-email",
            headers: { "content-type": "application/json" },
            payload: raw,
          })
        ).statusCode,
      ).toBe(401);
      expect(receive).not.toHaveBeenCalled();
      const good = await app.inject({
        method: "POST",
        url: "/webhooks/invitation-email",
        headers,
        payload: raw,
      });
      expect(good.statusCode).toBe(200);
      expect(good.body).not.toContain("synthetic@example.test");
      receive.mockResolvedValueOnce("retry");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/webhooks/invitation-email",
            headers,
            payload: raw,
          })
        ).statusCode,
      ).toBe(503);
      receive.mockRejectedValueOnce(Error("untrusted body must not leak"));
      const failed = await app.inject({
        method: "POST",
        url: "/webhooks/invitation-email",
        headers,
        payload: raw,
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain("untrusted");
      const invalid = "{broken";
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/webhooks/invitation-email",
            headers: { "content-type": "application/json", ...sign(invalid) },
            payload: invalid,
          })
        ).statusCode,
      ).toBe(400);
      const huge = "x".repeat(17000);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/webhooks/invitation-email",
            headers: { "content-type": "application/json", ...sign(huge) },
            payload: huge,
          })
        ).statusCode,
      ).toBe(413);
      expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
    const disabled = await buildApp();
    try {
      expect(
        (
          await disabled.inject({
            method: "POST",
            url: "/webhooks/invitation-email",
            headers,
            payload: raw,
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await disabled.close();
    }
  });
  it("does not poll using a sending-only credential", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new InviteEmailProvider("re_synthetic", fetcher, false);
    expect(await provider.status("existing-provider-id")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
