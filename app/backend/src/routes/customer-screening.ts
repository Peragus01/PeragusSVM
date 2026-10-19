import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CustomerScreeningService } from "../onboarding/customer-screening-service.js";
import { ScreeningError } from "../onboarding/screening-types.js";
import { OzavClientError } from "../providers/ozav-client.js";
export async function registerCustomerScreeningRoutes(app: FastifyInstance, service?: CustomerScreeningService) {
  await app.register(async scoped => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 8192 }, (_request, body, done) => done(null, body));
    for (const action of ["read", "start", "refresh"] as const) scoped.route({
      method: action === "read" ? "GET" : "POST", bodyLimit: 8192,
      url: `/v1/me/onboarding/screening${action === "refresh" ? `/${action}` : ""}`,
      handler: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!request.authenticatedUser) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
        if (!service) return reply.code(503).send({ error: { code: "CUSTOMER_SCREENINGS_DISABLED" } });
        const customer = request.authenticatedCustomer;
        if (!customer || customer.type !== "pf" || customer.suspended) return reply.code(403).send({ error: { code: "INDIVIDUAL_PROFILE_REQUIRED" } });
        try {
          if (action === "read") return { data: await service.read(customer.id) };
          let body: unknown;
          try { body = request.body === undefined ? {} : JSON.parse((request.body as Buffer).toString("utf8")); }
          catch { return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } }); }
          if (!z.object({}).strict().safeParse(body).success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
          if (action === "refresh") return { data: await service.refresh(customer.id) };
          const result = await service.start(customer.id);
          return reply.code(result.replayed ? 200 : 201).send({ data: result.data, meta: { idempotent_replay: result.replayed, operations_enabled: false } });
        } catch (error) {
          if (error instanceof ScreeningError) return reply.code(409).send({ error: { code: error.code } });
          if (error instanceof OzavClientError) return reply.code(502).send({ error: { code: "SCREENING_PROVIDER_UNAVAILABLE", provider_http_status: error.statusCode ?? null, retryable: error.retryable } });
          request.log.warn({ event: "customer_screening_unavailable" });
          return reply.code(503).send({ error: { code: "CUSTOMER_SCREENING_UNAVAILABLE" } });
        }
      },
    });
  });
}
