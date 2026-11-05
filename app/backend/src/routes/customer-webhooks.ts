import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CustomerWebhookConflict, customerEventSchema, verifyCustomerSignature, type CustomerWebhookProcessor } from "../webhooks/customer-event.js";

export interface CustomerWebhookOptions {
  secret: string;
  processor: CustomerWebhookProcessor;
  now?: () => Date;
}
export async function registerCustomerWebhookRoutes(app: FastifyInstance, options?: CustomerWebhookOptions): Promise<void> {
  // Scope the raw-byte parser to this endpoint; all existing JSON routes keep their parser.
  await app.register(async receiver => {
    receiver.removeContentTypeParser("application/json");
    receiver.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 64 * 1024 },
      (_request, body, done) => done(null, body));
    receiver.post("/webhooks/customer-updates", { bodyLimit: 64 * 1024 }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!options) return reply.code(503).send({ error: { code: "CUSTOMER_WEBHOOKS_DISABLED" } });
      if (!Buffer.isBuffer(request.body)
        || !verifyCustomerSignature(request.body, request.headers["x-ozav-signature"], options.secret, (options.now ?? (() => new Date()))())) {
        return reply.code(401).send({ error: { code: "WEBHOOK_SIGNATURE_INVALID" } });
      }
      let input: unknown;
      try { input = JSON.parse(request.body.toString("utf8")); }
      catch { return reply.code(400).send({ error: { code: "WEBHOOK_EVENT_INVALID" } }); }
      const parsed = customerEventSchema.safeParse(input);
      if (!parsed.success || request.headers["x-ozav-event-id"] !== parsed.data.id) {
        return reply.code(400).send({ error: { code: "WEBHOOK_EVENT_INVALID" } });
      }
      // A dashboard endpoint may receive both environments. Never refresh a test link from a live event.
      if (parsed.data.livemode) return { received: true, result: "ignored_environment" };
      const digest = createHash("sha256").update(request.body).digest("hex");
      try {
        const result = await options.processor.process(parsed.data, digest);
        request.log.info({ event: "customer_webhook_received", eventId: parsed.data.id, result });
        return { received: true, result };
      } catch (error) {
        if (error instanceof CustomerWebhookConflict) return reply.code(409).send({ error: { code: "WEBHOOK_EVENT_CONFLICT" } });
        // Non-2xx asks the sender to retry. Do not log exception text, provider bodies or headers.
        request.log.warn({ event: "customer_webhook_retry_required", eventId: parsed.data.id });
        return reply.code(503).send({ error: { code: "WEBHOOK_RETRY_REQUIRED" } });
      }
    });
  });
}
