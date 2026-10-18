import { OzavClientError } from "../providers/ozav-client.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CustomerTermsService } from "../onboarding/customer-terms-service.js";
import { TermsFlowError } from "../onboarding/terms-types.js";
export async function registerCustomerTermsRoutes(app: FastifyInstance, service?: CustomerTermsService): Promise<void> {
  await app.register(async scoped => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 8192 }, (_request, body, done) => done(null, body));
    for (const action of ["read", "create", "accept"] as const) scoped.route({
      method: action === "read" ? "GET" : "POST", bodyLimit: 8192,
      url: `/v1/me/onboarding/terms${action === "accept" ? "/accept" : ""}`,
      handler: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!request.authenticatedUser) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
        if (!service) return reply.code(503).send({ error: { code: "CUSTOMER_TERMS_DISABLED" } });
        const customer = request.authenticatedCustomer;
        if (!customer || customer.type !== "pf" || customer.suspended) return reply.code(403).send({ error: { code: "INDIVIDUAL_PROFILE_REQUIRED" } });
        try {
          if (action === "read") return { data: await service.read(customer.id) };
          let body: unknown;
          try { body = request.body === undefined ? {} : JSON.parse((request.body as Buffer).toString("utf8")); }
          catch { return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } }); }
          if (action === "create") {
            const parsed = z.object({ renew_session_id: z.string().uuid().optional() }).strict().safeParse(body);
            if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
            const result = await service.start(customer.id, parsed.data.renew_session_id);
            return reply.code(result.created ? 201 : 200).send({ data: result.data });
          }
          const parsed = z.object({ session_id: z.string().uuid(), accepted: z.literal(true) }).strict().safeParse(body);
          if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
          return { data: await service.accept(customer.id, parsed.data.session_id) };
        } catch (error) {
          if (error instanceof TermsFlowError) {
            if (error.code === "TERMS_PROCESSING") reply.header("Retry-After", "30");
            return reply.code(error.code === "TERMS_SESSION_NOT_FOUND" ? 404 : 409).send({ error: { code: error.code } });
          }
          if (error instanceof OzavClientError) return reply.code(503).send({ error: {
            code: "CUSTOMER_TERMS_PROVIDER_UNAVAILABLE", provider_http_status: error.statusCode ?? null, retryable: error.retryable,
          } });
          request.log.warn({ event: "customer_terms_unavailable" });
          return reply.code(503).send({ error: { code: "CUSTOMER_TERMS_UNAVAILABLE" } });
        }
      },
    });
  });
}
