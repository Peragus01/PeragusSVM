import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiRateLimiter } from "./api-rate-limits.js";
import {
  LEGAL_DOCUMENTS,
  LegalAcceptanceError,
  sanitizeIp,
  sanitizeUserAgent,
  type LegalAcceptanceService,
} from "../legal/legal-acceptance.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  assuranceLevel?: "aal2";
  /**
   * Epoch seconds of the TOTP verification (the `totp` entry of the verified token's
   * `amr` claim). Only set after the Auth server accepted that exact token.
   */
  mfaVerifiedAt?: number;
}
export interface Customer {
  id: string;
  ownerUserId: string;
  type: "pf" | "pj";
  displayName: string;
  verificationStatus:
    | "draft"
    | "submitted"
    | "in_review"
    | "action_required"
    | "approved"
    | "rejected";
  suspended: boolean;
}
export interface CustomerRepository {
  findByOwner(userId: string): Promise<Customer | null>;
  createOrGet(input: {
    ownerUserId: string;
    type: "pf" | "pj";
    displayName: string;
  }): Promise<{ customer: Customer; created: boolean }>;
  updateDisplayName?(
    userId: string,
    expectedName: string,
    displayName: string,
  ): Promise<Customer | null>;
  ownsSettlement(customerId: string, settlementId: string): Promise<boolean>;
}
export class AuthenticationError extends Error {
  constructor(
    public readonly code:
      "INVALID_TOKEN" | "EMAIL_NOT_CONFIRMED" | "AUTH_UNAVAILABLE",
  ) {
    super(code);
  }
}
export interface CustomerAccess {
  authenticate(token: string): Promise<AuthenticatedUser>;
  customers: CustomerRepository;
  /**
   * Required: every customer route (except the exempt list below) answers 403
   * LEGAL_ACCEPTANCE_REQUIRED until the current required documents are accepted.
   * There is no way to wire customer access without it.
   */
  legal: LegalAcceptanceService;
}

declare module "fastify" {
  interface FastifyRequest {
    authenticatedUser: AuthenticatedUser | null;
    authenticatedCustomer: Customer | null;
  }
}
const profileSchema = z
  .object({
    type: z.enum(["pf", "pj"]),
    display_name: z.string().trim().min(2).max(160),
  })
  .strict();
const uuid = z.string().uuid();
const serialize = (c: Customer) => ({
  id: c.id,
  type: c.type,
  display_name: c.displayName,
  verification_status: c.verificationStatus,
  suspended: c.suspended,
  operations_enabled: false,
});
// Routes a customer without the required acceptance may still call: the acceptance
// endpoints themselves and the static capability flags the frontend needs to render
// the acceptance step. (/v1/me, /v1/me/customer and the pilot-invite redeem return
// earlier in the hook, before customer lookup, and are exempt as well.)
const LEGAL_EXEMPT_PATHS = new Set([
  "/v1/me/legal-acceptances",
  "/v1/me/purchase-capabilities",
]);
const acceptanceSchema = z
  .object({
    documents: z
      .array(
        z
          .object({
            document: z.enum(LEGAL_DOCUMENTS),
            version: z.string().min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(LEGAL_DOCUMENTS.length),
  })
  .strict();
const isVersioned = (path: string) => path === "/v1" || path.startsWith("/v1/");

export function registerCustomerAccess(
  app: FastifyInstance,
  access: CustomerAccess,
  requirePilotInvite = false,
  rateLimiter?: ApiRateLimiter,
): void {
  if (!access.legal)
    throw new Error("LEGAL_ACCEPTANCE_SERVICE_REQUIRED");
  const legal = access.legal;
  app.decorateRequest("authenticatedUser", null);
  app.decorateRequest("authenticatedCustomer", null);
  app.addHook("preHandler", async (request, reply) => {
    const path =
      request.routeOptions.url ??
      new URL(request.url, "http://internal").pathname;
    if (!isVersioned(path)) return;
    reply.header("Cache-Control", "no-store");
    const authorization = request.headers.authorization;
    const match = authorization && /^Bearer ([^\s,]+)$/i.exec(authorization);
    if (!match || match[1]!.length > 8192) {
      reply.header("WWW-Authenticate", "Bearer");
      return reply.code(401).send({
        error: {
          code: "AUTH_REQUIRED",
          message: "A valid access token is required",
        },
      });
    }
    try {
      request.authenticatedUser = await access.authenticate(match[1]!);
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error;
      const status =
        error.code === "AUTH_UNAVAILABLE"
          ? 503
          : error.code === "EMAIL_NOT_CONFIRMED"
            ? 403
            : 401;
      if (status === 401) reply.header("WWW-Authenticate", "Bearer");
      return reply.code(status).send({
        error: {
          code: error.code,
          message: "Authentication could not be completed",
        },
      });
    }
    if (rateLimiter) {
      try {
        const quota = await rateLimiter.consume(
          request.authenticatedUser.id,
          request.method,
        );
        reply.header("RateLimit-Limit", quota.limit);
        reply.header("RateLimit-Remaining", quota.remaining);
        if (!quota.allowed)
          return reply
            .header("Retry-After", quota.retryAfterSeconds)
            .code(429)
            .send({ error: { code: "API_RATE_LIMIT_EXCEEDED" } });
      } catch {
        request.log.warn({ event: "api_rate_limit_store_unavailable" });
        return reply
          .header("Retry-After", "1")
          .code(503)
          .send({ error: { code: "API_RATE_LIMIT_UNAVAILABLE" } });
      }
    }
    if (
      path === "/v1/me" ||
      path === "/v1/me/customer" ||
      path === "/v1/me/pilot-invite/redeem" ||
      // Any authenticated user (AAL1) may ask whether it is an operator; the
      // handler answers only that boolean.
      path === "/v1/admin/operator-status"
    )
      return;
    // Exact operator resource: authentication still runs above. Its own handler
    // requires the server allowlist and verified MFA; a customer profile is not a role.
    if (
      [
        "/v1/admin/withdrawal-requests/:id/execution/closure",
        "/v1/admin/operational-alerts",
        "/v1/admin/operator-notifications",
        "/v1/admin/runtime-controls",
        "/v1/admin/daily-reviews",
        "/v1/admin/pilot-invites",
        "/v1/admin/pilot-invites/:id",
        "/v1/admin/pilot-invites/:id/revoke",
        "/v1/admin/customer-reconciliation",
        "/v1/admin/refund-requests",
        "/v1/admin/refund-requests/:id",
        "/v1/admin/refund-requests/:id/decision",
        "/v1/admin/refund-requests/:id/completion",
        "/v1/admin/operations/:id/refund-decision",
        "/v1/admin/withdrawal-requests/:id/audit",
        "/v1/admin/withdrawal-requests",
        "/v1/admin/withdrawal-requests/:id/approval",
        "/v1/admin/withdrawal-requests/:id/execution",
        "/v1/admin/withdrawal-requests/:id/execution/reconcile",
      ].includes(path)
    ) {
      if (await access.customers.findByOwner(request.authenticatedUser.id)) {
        return reply
          .code(403)
          .send({ error: { code: "OPERATOR_ACCOUNT_SEPARATION_REQUIRED" } });
      }
      return;
    }
    const customer = await access.customers.findByOwner(
      request.authenticatedUser.id,
    );
    if (!customer)
      return reply.code(403).send({
        error: {
          code: "CUSTOMER_REQUIRED",
          message: "Create a customer profile first",
        },
      });
    request.authenticatedCustomer = customer;
    if (customer.suspended)
      return reply.code(403).send({
        error: {
          code: "CUSTOMER_SUSPENDED",
          message: "Customer access is suspended",
        },
      });

    if (!LEGAL_EXEMPT_PATHS.has(path)) {
      let missing: unknown[];
      try {
        missing = await legal.missing(customer.id);
      } catch {
        request.log.warn({ event: "legal_acceptance_check_unavailable" });
        return reply
          .code(503)
          .send({ error: { code: "LEGAL_ACCEPTANCE_UNAVAILABLE" } });
      }
      if (missing.length)
        return reply.code(403).send({
          error: {
            code: "LEGAL_ACCEPTANCE_REQUIRED",
            message: "Accept the current legal documents to continue",
          },
        });
    }

    // This gate protects every settlement subresource before any provider or repository handler runs.
    if (path === "/v1/settlements" || path.startsWith("/v1/settlements/")) {
      const id = (request.params as { id?: string }).id;
      if (id !== undefined) {
        if (!uuid.safeParse(id).success)
          return reply.code(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: "Settlement ID is invalid",
            },
          });
        if (!(await access.customers.ownsSettlement(customer.id, id))) {
          return reply.code(404).send({
            error: {
              code: "SETTLEMENT_NOT_FOUND",
              message: "Settlement was not found",
            },
          });
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        const approved = customer.verificationStatus === "approved";
        return reply.code(approved ? 503 : 403).send({
          error: {
            code: approved ? "OPERATIONS_NOT_ENABLED" : "CUSTOMER_NOT_APPROVED",
            message: approved
              ? "Customer payment routing is not enabled"
              : "Customer verification is not approved",
          },
        });
      }
    }
  });
  app.get("/v1/me", async (request) => ({
    data: {
      user: request.authenticatedUser,
      customer: await profileFor(request, access),
    },
  }));
  app.get("/v1/me/customer", async (request) => ({
    data: await profileFor(request, access),
  }));
  {
    app.get("/v1/me/legal-acceptances", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (Object.keys(request.query as object).length)
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      try {
        return { data: await legal.status(request.authenticatedCustomer!.id) };
      } catch {
        return reply
          .code(503)
          .send({ error: { code: "LEGAL_ACCEPTANCE_UNAVAILABLE" } });
      }
    });
    app.post("/v1/me/legal-acceptances", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const parsed = acceptanceSchema.safeParse(request.body);
      if (!parsed.success || Object.keys(request.query as object).length)
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      try {
        const data = await legal.accept(
          {
            userId: request.authenticatedUser!.id,
            customerId: request.authenticatedCustomer!.id,
            // request.ip is what Fastify resolved from its own trust-proxy setting.
            ip: sanitizeIp(request.ip),
            userAgent: sanitizeUserAgent(request.headers["user-agent"]),
          },
          parsed.data.documents,
        );
        return reply.code(201).send({ data });
      } catch (error) {
        if (error instanceof LegalAcceptanceError)
          return reply
            .code(409)
            .send({ error: { code: "LEGAL_VERSION_MISMATCH" } });
        request.log.warn({ event: "legal_acceptance_unavailable" });
        return reply
          .code(503)
          .send({ error: { code: "LEGAL_ACCEPTANCE_UNAVAILABLE" } });
      }
    });
  }
  app.register(async (scoped) => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 4096 },
      (_request, body, done) => done(null, body),
    );
    scoped.patch("/v1/me/customer", async (request, reply) => {
      let body: unknown;
      try {
        body = JSON.parse((request.body as Buffer).toString("utf8"));
      } catch {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      }
      const parsed = z
        .object({
          display_name: z
            .string()
            .trim()
            .min(2)
            .max(160)
            .regex(/^[^\x00-\x1f\x7f]+$/),
          expected_display_name: z.string().min(2).max(160),
        })
        .strict()
        .safeParse(body);
      if (!parsed.success || Object.keys(request.query as object).length)
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      const prior = await access.customers.findByOwner(
        request.authenticatedUser!.id,
      );
      if (!prior || prior.suspended)
        return reply.code(403).send({ error: { code: "CUSTOMER_REQUIRED" } });
      if (!access.customers.updateDisplayName)
        return reply
          .code(503)
          .send({ error: { code: "PROFILE_UPDATE_UNAVAILABLE" } });
      const updated = await access.customers.updateDisplayName(
        request.authenticatedUser!.id,
        parsed.data.expected_display_name,
        parsed.data.display_name,
      );
      if (!updated)
        return reply
          .code(409)
          .send({ error: { code: "PROFILE_VERSION_CONFLICT" } });
      return { data: serialize(updated) };
    });
  });
  app.post("/v1/me/customer", async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Expected type and display_name only",
        },
      });
    if (
      requirePilotInvite &&
      !(await access.customers.findByOwner(request.authenticatedUser!.id))
    )
      return reply.code(403).send({ error: { code: "PILOT_INVITE_REQUIRED" } });
    const { customer, created } = await access.customers.createOrGet({
      ownerUserId: request.authenticatedUser!.id,
      type: parsed.data.type,
      displayName: parsed.data.display_name,
    });
    if (
      customer.type !== parsed.data.type ||
      customer.displayName !== parsed.data.display_name
    ) {
      return reply.code(409).send({
        error: {
          code: "CUSTOMER_ALREADY_EXISTS",
          message: "A different profile already exists for this user",
        },
      });
    }
    return reply.code(created ? 201 : 200).send({ data: serialize(customer) });
  });
}
async function profileFor(request: FastifyRequest, access: CustomerAccess) {
  const customer = await access.customers.findByOwner(
    request.authenticatedUser!.id,
  );
  return customer ? serialize(customer) : null;
}
