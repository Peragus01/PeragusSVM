import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { OzavSandboxCustomerService, SandboxCustomerError, type SandboxCustomerLink } from "../application/ozav-sandbox-customer.js";
import { OzavClientError } from "../providers/ozav-client.js";
const view = (link: SandboxCustomerLink | null) => link ? ({
  customer_id: link.customerId, environment: link.environment, sandbox_fixture: true,
  state: link.state, ozav_customer_id: link.ozavCustomerId, provider_status: link.providerStatus,
  verification_mode: link.verificationMode, provider_snapshot: link.snapshot, refreshed_at: link.refreshedAt, operations_enabled: false,
}) : null;
export function registerOzavSandboxCustomerRoutes(app: FastifyInstance, service?: OzavSandboxCustomerService): void {
  for (const action of ["read", "create", "refresh"] as const) {
    const method = action === "read" ? "GET" : "POST";
    app.route({
    method, url: `/v1/me/ozav-sandbox-customer${action === "refresh" ? "/refresh" : ""}`,
    handler: async (request, reply) => {
      if (!request.authenticatedUser) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
      if (!service) return reply.code(503).send({ error: { code: "OZAV_SANDBOX_CUSTOMERS_DISABLED" } });
      const customer = request.authenticatedCustomer;
      if (!customer || customer.suspended) return reply.code(403).send({ error: { code: "CUSTOMER_REQUIRED" } });
      if (customer.type !== "pf") return reply.code(403).send({ error: { code: "SANDBOX_CUSTOMER_PF_ONLY" } });
      if (method === "GET") return { data: view(await service.read(customer.id)) };
      if (!z.object({}).strict().safeParse(request.body ?? {}).success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      try {
        if (action === "refresh") return { data: view(await service.refresh(customer.id)) };
        const result = await service.execute(customer.id);
        reply.header("Idempotency-Replayed", String(result.replayed));
        return reply.code(result.replayed ? 200 : 201).send({ data: view(result.link), meta: { idempotent_replay: result.replayed } });
      } catch (error) {
        if (error instanceof SandboxCustomerError) return reply.code(409).send({ error: { code: error.code } });
        if (error instanceof OzavClientError) return reply.code(502).send({ error: {
          code: "OZAV_SANDBOX_CUSTOMER_UNAVAILABLE", provider_http_status: error.statusCode ?? null,
          retryable: error.retryable, automatic_linking: false,
        } });
        throw error;
      }
    },
  });
  }
}
