import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
const eventSchema = z.object({
  type: z.enum([
    "email.delivered",
    "email.bounced",
    "email.complained",
    "email.failed",
  ]),
  data: z.object({
    email_id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    subject: z.string().max(1000),
  }),
});
export function verifyInviteDelivery(
  raw: Buffer,
  headers: Record<string, unknown>,
  secret: string,
  now = Date.now(),
) {
  const id = headers["svix-id"],
    ts = headers["svix-timestamp"],
    signatures = headers["svix-signature"];
  if (
    typeof id !== "string" ||
    !/^msg_[A-Za-z0-9_-]{1,160}$/.test(id) ||
    typeof ts !== "string" ||
    !/^\d{1,12}$/.test(ts) ||
    typeof signatures !== "string" ||
    signatures.length > 2048 ||
    !secret.startsWith("whsec_")
  )
    return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 16 || key.length > 128) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${ts}.`)
    .update(raw)
    .digest();
  return signatures
    .split(" ")
    .slice(0, 8)
    .some((s) => {
      if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(s)) return false;
      const actual = Buffer.from(s.slice(3), "base64");
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    });
}
export class InviteEmailDelivery {
  constructor(private readonly db: Pick<Pool, "query">) {}
  async receive(input: unknown) {
    const event = eventSchema.safeParse(input);
    if (!event.success) throw Error("INVITE_DELIVERY_EVENT_INVALID");
    const { type, data } = event.data;
    // Never touch another queue, regardless of webhook account/domain coverage.
    if (data.subject !== "[TESTES] Seu convite para a Peragus")
      return "ignored";
    const result = await this.db.query(
      `update peragus_invite_email_outbox set
   state=case when $2='email.delivered' and state='accepted' then 'delivered'
     when $2<>'email.delivered' then 'failed' else state end,
   delivered_at=case when $2='email.delivered' then coalesce(delivered_at,clock_timestamp()) else delivered_at end,
   last_error=case when $2='email.complained' then 'COMPLAINED' when $2='email.bounced' and last_error is distinct from 'COMPLAINED' then 'BOUNCED'
     when $2='email.failed' and last_error is null then 'PROVIDER_FAILED' else last_error end,
   last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
   where environment='test' and provider_email_id=$1 and state in ('accepted','delivered','failed') returning invite_id`,
      [data.email_id, type],
    );
    // Acceptance may not have committed yet. A signed retry closes that race.
    return result.rows.length ? "recorded" : "retry";
  }
}
