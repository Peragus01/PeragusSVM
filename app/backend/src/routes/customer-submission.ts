import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CustomerSubmissionService } from "../onboarding/customer-submission-service.js";
import { SubmissionError } from "../onboarding/submission-types.js";
import { TermsFlowError } from "../onboarding/terms-types.js";
import { OzavClientError } from "../providers/ozav-client.js";
export async function registerCustomerSubmissionRoutes(app: FastifyInstance, service?: CustomerSubmissionService): Promise<void> {
  await app.register(async scoped => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 8192 }, (_request, body, done) => done(null, body));
    for (const action of ["read", "submit", "refresh"] as const) scoped.route({
      method: action === "read" ? "GET" : "POST", bodyLimit: 8192,
      url: `/v1/me/onboarding${action === "read" ? "" : `/${action}`}`,
      handler: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!request.authenticatedUser) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
        if (!service) return reply.code(503).send({ error: { code: "CUSTOMER_SUBMISSION_DISABLED" } });
        const customer = request.authenticatedCustomer;
        if (!customer || customer.type !== "pf" || customer.suspended) return reply.code(403).send({ error: { code: "INDIVIDUAL_PROFILE_REQUIRED" } });
        try {
          if (action === "read") return { data: await service.read(customer.id), meta: { operations_enabled: false } };
          let body: unknown;
          try { body = request.body === undefined ? {} : JSON.parse((request.body as Buffer).toString("utf8")); }
          catch { return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } }); }
          if (action === "refresh") {
            if (!z.object({}).strict().safeParse(body).success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
            return { data: await service.refresh(customer.id) };
          }
          const parsed = z.object({ draft_version: z.number().int().min(1).max(2_000_000_000), terms_session_id: z.string().uuid(), sandbox_data_confirmed: z.literal(true) }).strict().safeParse(body);
          if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
          const result = await service.submit(customer.id, parsed.data.draft_version, parsed.data.terms_session_id);
          reply.header("Idempotency-Replayed", String(result.replayed));
          return reply.code(result.replayed ? 200 : 201).send({ data: result.data, meta: { idempotent_replay: result.replayed, operations_enabled: false } });
        } catch (error) {
          if (error instanceof SubmissionError || error instanceof TermsFlowError) return reply.code(409).send({ error: { code: error.code } });
          if (error instanceof OzavClientError) return reply.code(502).send({ error: { code: "ONBOARDING_PROVIDER_UNAVAILABLE", provider_http_status: error.statusCode ?? null, retryable: error.retryable, automatic_linking: false } });
          request.log.warn({ event: "customer_submission_unavailable" });
          return reply.code(503).send({ error: { code: "CUSTOMER_SUBMISSION_UNAVAILABLE" } });
        }
      },
    });
  });
}
