import {createHash} from "node:crypto";

// RFC 4122 name-based (SHA-1, v5) UUID in a fixed Peragus namespace: request_id
// columns are uuid, so `system-<purchaseId>` is stored as its deterministic UUID.
const NAMESPACE = Buffer.from("8f0d5a4e2c7b4e1f9a63d1b07c5e2f48", "hex");
export function systemRequestId(name: string): string {
  const h = createHash("sha1").update(NAMESPACE).update(name, "utf8").digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
/** Reason of every system-created manual refund request (constant, so replays are idempotent). */
export const SYSTEM_REFUND_REASON = "Automatic request: the Pix payment was received but the OZAV transfer did not complete.";
