import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const customerEventSchema = z.object({
  id: z.string().regex(/^ozav_evt_[A-Za-z0-9_]{1,160}$/),
  object: z.literal("event"),
  type: z.string().max(100).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  created_at: z.string().datetime({ offset: true }),
  // Older deliveries without an environment are deliberately not trusted here.
  livemode: z.boolean(),
  data: z.record(z.string(), z.unknown()),
});
export type CustomerWebhookEvent = z.infer<typeof customerEventSchema>;
export type CustomerWebhookResult = "processed" | "ignored" | "duplicate";
export interface CustomerWebhookProcessor {
  process(event: CustomerWebhookEvent, digest: string): Promise<CustomerWebhookResult>;
}
export class CustomerWebhookConflict extends Error {}

/** Verify original bytes, the full prefixed secret, and a bounded delivery time. */
export function verifyCustomerSignature(raw: Buffer, header: unknown, secret: string, now: Date): boolean {
  if (typeof header !== "string" || header.length > 1024 || !secret.startsWith("ozav_whsec_")) return false;
  const fields = header.split(",").map(field => field.trim());
  const times = fields.filter(field => field.startsWith("t="));
  const signatures = fields.filter(field => field.startsWith("v1="));
  if (times.length !== 1 || signatures.length < 1 || signatures.length > 4
    || fields.length !== times.length + signatures.length) return false;
  const timestamp = times[0]!.slice(2);
  if (!/^[0-9]{1,12}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now.getTime() / 1000 - seconds) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  return signatures.some(field => {
    const value = field.slice(3);
    return /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(expected, Buffer.from(value, "hex"));
  });
}
