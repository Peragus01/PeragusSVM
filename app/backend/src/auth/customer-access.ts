import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

export interface AuthenticatedUser { id: string; email: string; assuranceLevel?: "aal2"; }
export interface Customer {
  id: string;
  ownerUserId: string;
  type: "pf" | "pj";
  displayName: string;
  verificationStatus: "draft" | "submitted" | "in_review" | "action_required" | "approved" | "rejected";
  suspended: boolean;
}
export interface CustomerRepository {
  findByOwner(userId: string): Promise<Customer | null>;
  createOrGet(input: { ownerUserId: string; type: "pf" | "pj"; displayName: string }): Promise<{ customer: Customer; created: boolean }>;
  ownsSettlement(customerId: string, settlementId: string): Promise<boolean>;
}
export class AuthenticationError extends Error {
  constructor(public readonly code: "INVALID_TOKEN" | "EMAIL_NOT_CONFIRMED" | "AUTH_UNAVAILABLE") {
    super(code);
  }
}
export interface CustomerAccess {
  authenticate(token: string): Promise<AuthenticatedUser>;
  customers: CustomerRepository;
}

declare module "fastify" {
  interface FastifyRequest { authenticatedUser: AuthenticatedUser | null; authenticatedCustomer: Customer | null; }
}
const profileSchema = z.object({
  type: z.enum(["pf", "pj"]),
  display_name: z.string().trim().min(2).max(160),
}).strict();
const uuid = z.string().uuid();
const serialize = (c: Customer) => ({
  id: c.id, type: c.type, display_name: c.displayName,
  verification_status: c.verificationStatus, suspended: c.suspended,
  operations_enabled: false,
});
const isVersioned = (path: string) => path === "/v1" || path.startsWith("/v1/");

export function registerCustomerAccess(app: FastifyInstance, access: CustomerAccess): void {
  app.decorateRequest("authenticatedUser", null);
  app.decorateRequest("authenticatedCustomer", null);
  app.addHook("preHandler", async (request, reply) => {
    const path = request.routeOptions.url ?? new URL(request.url, "http://internal").pathname;
    if (!isVersioned(path)) return;
    reply.header("Cache-Control", "no-store");
    const authorization = request.headers.authorization;
    const match = authorization && /^Bearer ([^\s,]+)$/i.exec(authorization);
    if (!match || match[1]!.length > 8192) {
      reply.header("WWW-Authenticate", "Bearer");
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "A valid access token is required" } });
    }
    try {
      request.authenticatedUser = await access.authenticate(match[1]!);
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error;
      const status = error.code === "AUTH_UNAVAILABLE" ? 503 : error.code === "EMAIL_NOT_CONFIRMED" ? 403 : 401;
      if (status === 401) reply.header("WWW-Authenticate", "Bearer");
      return reply.code(status).send({ error: { code: error.code, message: "Authentication could not be completed" } });
    }
    if (path === "/v1/me" || path === "/v1/me/customer") return;
    // Exact operator resource: authentication still runs above. Its own handler
    // requires the server allowlist and verified MFA; a customer profile is not a role.
    if (["/v1/admin/refund-requests", "/v1/admin/refund-requests/:id", "/v1/admin/refund-requests/:id/decision", "/v1/admin/refund-requests/:id/completion", "/v1/admin/withdrawal-requests/:id/audit", "/v1/admin/withdrawal-requests", "/v1/admin/withdrawal-requests/:id/approval", "/v1/admin/withdrawal-requests/:id/execution", "/v1/admin/withdrawal-requests/:id/execution/reconcile"].includes(path)) {
      if (await access.customers.findByOwner(request.authenticatedUser.id)) {
        return reply.code(403).send({error:{code:"OPERATOR_ACCOUNT_SEPARATION_REQUIRED"}});
      }
      return;
    }
    const customer = await access.customers.findByOwner(request.authenticatedUser.id);
    if (!customer) return reply.code(403).send({ error: { code: "CUSTOMER_REQUIRED", message: "Create a customer profile first" } });
    request.authenticatedCustomer = customer;
    if (customer.suspended) return reply.code(403).send({ error: { code: "CUSTOMER_SUSPENDED", message: "Customer access is suspended" } });

    // This gate protects every settlement subresource before any provider or repository handler runs.
    if (path === "/v1/settlements" || path.startsWith("/v1/settlements/")) {
      const id = (request.params as { id?: string }).id;
      if (id !== undefined) {
        if (!uuid.safeParse(id).success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Settlement ID is invalid" } });
        if (!await access.customers.ownsSettlement(customer.id, id)) {
          return reply.code(404).send({ error: { code: "SETTLEMENT_NOT_FOUND", message: "Settlement was not found" } });
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        const approved = customer.verificationStatus === "approved";
        return reply.code(approved ? 503 : 403).send({ error: {
          code: approved ? "OPERATIONS_NOT_ENABLED" : "CUSTOMER_NOT_APPROVED",
          message: approved ? "Customer payment routing is not enabled" : "Customer verification is not approved",
        } });
      }
    }
  });
  app.get("/v1/me", async (request) => ({ data: {
    user: request.authenticatedUser,
    customer: await profileFor(request, access),
  } }));
  app.get("/v1/me/customer", async (request) => ({ data: await profileFor(request, access) }));
  app.post("/v1/me/customer", async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Expected type and display_name only" } });
    const { customer, created } = await access.customers.createOrGet({
      ownerUserId: request.authenticatedUser!.id,
      type: parsed.data.type, displayName: parsed.data.display_name,
    });
    if (customer.type !== parsed.data.type || customer.displayName !== parsed.data.display_name) {
      return reply.code(409).send({ error: { code: "CUSTOMER_ALREADY_EXISTS", message: "A different profile already exists for this user" } });
    }
    return reply.code(created ? 201 : 200).send({ data: serialize(customer) });
  });
}
async function profileFor(request: FastifyRequest, access: CustomerAccess) {
  const customer = await access.customers.findByOwner(request.authenticatedUser!.id);
  return customer ? serialize(customer) : null;
}
