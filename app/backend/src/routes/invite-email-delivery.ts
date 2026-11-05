import type { FastifyInstance } from "fastify";
import {
  verifyInviteDelivery,
  type InviteEmailDelivery,
} from "../invites/invite-email-delivery.js";
export interface InviteDeliveryOptions {
  secret: string;
  service: InviteEmailDelivery;
  now?: () => number;
}
export async function registerInviteDeliveryRoute(
  app: FastifyInstance,
  options?: InviteDeliveryOptions,
) {
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 16384 },
      (_request, body, done) => done(null, body),
    );
    scope.post(
      "/webhooks/invitation-email",
      { bodyLimit: 16384 },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!options)
          return reply
            .code(503)
            .send({ error: { code: "INVITE_DELIVERY_DISABLED" } });
        if (
          !Buffer.isBuffer(request.body) ||
          !verifyInviteDelivery(
            request.body,
            request.headers,
            options.secret,
            options.now?.(),
          )
        )
          return reply
            .code(401)
            .send({ error: { code: "WEBHOOK_SIGNATURE_INVALID" } });
        let data: unknown;
        try {
          data = JSON.parse(request.body.toString("utf8"));
        } catch {
          return reply
            .code(400)
            .send({ error: { code: "WEBHOOK_EVENT_INVALID" } });
        }
        try {
          const result = await options.service.receive(data);
          if (result === "retry")
            return reply
              .code(503)
              .send({ error: { code: "INVITE_DELIVERY_RETRY" } });
          return { received: true, result };
        } catch {
          request.log.warn({ event: "invite_delivery_unconfirmed" });
          return reply
            .code(503)
            .send({ error: { code: "INVITE_DELIVERY_RETRY" } });
        }
      },
    );
  });
}
