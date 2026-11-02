import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CustomerAccess } from "../auth/customer-access.js";
import { AuthenticationError } from "../auth/customer-access.js";
import {
  CustomerDocumentService,
  DocumentError,
  documentInput,
  MAX_DOCUMENT_BYTES,
} from "../onboarding/customer-documents.js";

export async function registerCustomerDocumentRoutes(
  app: FastifyInstance,
  access?: CustomerAccess,
  service?: CustomerDocumentService,
) {
  await app.register(async (scoped) => {
    const active = new Set<string>();
    const bodyTimers = new Map<string, NodeJS.Timeout>();
    const clearBodyTimer = (id: string) => {
      clearTimeout(bodyTimers.get(id));
      bodyTimers.delete(id);
    };
    scoped.addHook("onRequest", async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const token = /^Bearer ([^\s,]+)$/i.exec(
        req.headers.authorization ?? "",
      )?.[1];
      if (!access || !token || token.length > 8192)
        return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
      try {
        const user = await access.authenticate(token);
        const customer = await access.customers.findByOwner(user.id);
        if (!customer || customer.type !== "pf" || customer.suspended)
          return reply
            .code(403)
            .send({ error: { code: "INDIVIDUAL_PROFILE_REQUIRED" } });
      } catch (e) {
        const code =
          e instanceof AuthenticationError ? e.code : "AUTH_UNAVAILABLE";
        return reply
          .code(
            code === "AUTH_UNAVAILABLE"
              ? 503
              : code === "EMAIL_NOT_CONFIRMED"
                ? 403
                : 401,
          )
          .send({ error: { code } });
      }
      if (!service)
        return reply
          .code(503)
          .send({ error: { code: "CUSTOMER_DOCUMENTS_DISABLED" } });
      if (req.method === "POST") {
        if (active.size >= 2)
          return reply
            .code(429)
            .send({ error: { code: "DOCUMENT_UPLOAD_BUSY" } });
        active.add(req.id);
        const timer = setTimeout(
          () => req.raw.destroy(new Error("DOCUMENT_BODY_TIMEOUT")),
          20000,
        );
        timer.unref();
        bodyTimers.set(req.id, timer);
      }
    });
    scoped.addHook("preValidation", async (req) => {
      clearBodyTimer(req.id);
    });
    scoped.addHook("onResponse", async (req) => {
      clearBodyTimer(req.id);
      active.delete(req.id);
    });
    scoped.addHook("onError", async (req) => {
      clearBodyTimer(req.id);
      active.delete(req.id);
    });
    scoped.addHook("preHandler", async (req, reply) => {
      const customer = req.authenticatedCustomer;
      if (!customer || customer.type !== "pf" || customer.suspended)
        return reply
          .code(403)
          .send({ error: { code: "INDIVIDUAL_PROFILE_REQUIRED" } });
    });
    for (const mime of ["image/jpeg", "image/png", "application/pdf"])
      scoped.addContentTypeParser(
        mime,
        { parseAs: "buffer", bodyLimit: MAX_DOCUMENT_BYTES },
        (_req, body, done) => done(null, body),
      );
    for (const requirement of [false, true])
      scoped.get(
        `/v1/me/onboarding/documents${requirement ? "/requirements" : ""}`,
        async (req, reply) => {
          if (req.body !== undefined)
            return reply
              .code(400)
              .send({ error: { code: "DOCUMENT_VALIDATION_ERROR" } });
          try {
            return {
              data: await service![requirement ? "requirements" : "list"](
                req.authenticatedCustomer!.id,
              ),
            };
          } catch (e) {
            return failure(e, reply);
          }
        },
      );
    scoped.post(
      "/v1/me/onboarding/documents",
      { bodyLimit: MAX_DOCUMENT_BYTES },
      async (req, reply) => {
        const input = documentInput.safeParse({
          request_id: req.headers["idempotency-key"],
          doc_type: req.headers["x-document-type"],
          side: req.headers["x-document-side"],
          mime: req.headers["content-type"],
        });
        if (!input.success || !Buffer.isBuffer(req.body))
          return reply
            .code(400)
            .send({ error: { code: "DOCUMENT_VALIDATION_ERROR" } });
        try {
          return await service!.send(
            req.authenticatedCustomer!.id,
            input.data,
            req.body,
          );
        } catch (e) {
          return failure(e, reply);
        } finally {
          req.body.fill(0);
        }
      },
    );
    for (const refresh of [false, true])
      scoped.route({
        method: refresh ? "POST" : "GET",
        url: `/v1/me/onboarding/documents/:id${refresh ? "/refresh" : ""}`,
        bodyLimit: 1024,
        handler: async (req, reply) => {
          const p = z.object({ id: z.uuid() }).safeParse(req.params);
          if (!p.success || req.body !== undefined)
            return reply
              .code(400)
              .send({ error: { code: "DOCUMENT_VALIDATION_ERROR" } });
          try {
            return {
              data: await service![refresh ? "refresh" : "read"](
                req.authenticatedCustomer!.id,
                p.data.id,
              ),
            };
          } catch (e) {
            return failure(e, reply);
          }
        },
      });
  });
}
function failure(error: unknown, reply: import("fastify").FastifyReply) {
  const code =
    error instanceof DocumentError
      ? error.code
      : "DOCUMENT_SERVICE_UNAVAILABLE";
  const status =
    code === "DOCUMENT_NOT_FOUND"
      ? 404
      : code === "DOCUMENT_VALIDATION_ERROR"
        ? 400
        : code === "DOCUMENT_SERVICE_UNAVAILABLE"
          ? 503
          : 409;
  return reply.code(status).send({ error: { code } });
}
