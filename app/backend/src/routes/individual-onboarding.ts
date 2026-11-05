import type { FastifyInstance } from "fastify";
import type { IndividualDraftService } from "../onboarding/individual-draft-service.js";
import { individualDraftRequestSchema } from "../onboarding/individual-schema.js";
import { DraftVersionConflict } from "../repositories/postgres-individual-draft.js";
export async function registerIndividualOnboardingRoutes(app: FastifyInstance, service?: IndividualDraftService): Promise<void> {
  await app.register(async scoped => {
    // Parse sensitive JSON ourselves so malformed bodies never appear in parser errors/logs.
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 16 * 1024 },
      (_request, body, done) => done(null, body));
  for (const method of ["GET", "PUT"] as const) scoped.route({ method, bodyLimit: 16 * 1024, url: "/v1/me/onboarding/individual",
    handler: async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!request.authenticatedUser) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
      if (!service) return reply.code(503).send({ error: { code: "CUSTOMER_ONBOARDING_DISABLED" } });
      const customer = request.authenticatedCustomer;
      if (!customer || customer.suspended || customer.type !== "pf") return reply.code(403).send({ error: { code: "INDIVIDUAL_PROFILE_REQUIRED" } });
      try {
        if (method === "GET") return { data: await service.read(customer.id), meta: { environment: "test", draft_only: true, operations_enabled: false } };
        let body: unknown;
        try {
          if (!Buffer.isBuffer(request.body)) throw new Error("Invalid JSON");
          body = JSON.parse(request.body.toString("utf8"));
        } catch { return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } }); }
        const parsed = individualDraftRequestSchema().safeParse(body);
        if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR",
          fields: [...new Set(parsed.error.issues.map(issue => issue.path.join(".")))],
        } });
        const data = await service.save(customer.id, parsed.data.expected_version, parsed.data.individual);
        return reply.code(parsed.data.expected_version === 0 ? 201 : 200).send({ data,
          meta: { environment: "test", draft_only: true, provider_submitted: false, operations_enabled: false } });
      } catch (error) {
        if (error instanceof DraftVersionConflict) return reply.code(409).send({ error: { code: "DRAFT_VERSION_CONFLICT" } });
        request.log.warn({ event: "individual_draft_unavailable" });
        return reply.code(503).send({ error: { code: "INDIVIDUAL_DRAFT_UNAVAILABLE" } });
      }
    },
  });
  });
}
