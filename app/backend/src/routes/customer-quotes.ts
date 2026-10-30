import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CustomerQuoteError,
  CustomerQuoteProviderError,
  type CustomerQuoteService,
} from "../quotes/customer-quotes.js";
export async function registerCustomerQuoteRoutes(
  app: FastifyInstance,
  service?: CustomerQuoteService,
) {
  await app.register(async (scoped) => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 4096 },
      (_req, body, done) => done(null, body),
    );
    for (const method of ["GET", "POST"] as const)
      scoped.route({
        method,
        url: method === "GET" ? "/v1/me/quotes/:id" : "/v1/me/quotes",
        bodyLimit: 4096,
        handler: async (request, reply) => {
          reply.header("Cache-Control", "no-store");
          if (!request.authenticatedUser)
            return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
          if (!service)
            return reply
              .code(503)
              .send({ error: { code: "CUSTOMER_QUOTES_DISABLED" } });
          const customer = request.authenticatedCustomer;
          if (!customer || customer.type !== "pf" || customer.suspended)
            return reply
              .code(403)
              .send({ error: { code: "INDIVIDUAL_PROFILE_REQUIRED" } });
          if (Object.keys(request.query as object).length)
            return reply
              .code(400)
              .send({ error: { code: "VALIDATION_ERROR" } });
          try {
            if (method === "GET") {
              const parsed = z
                .object({ id: z.string().uuid() })
                .safeParse(request.params);
              if (!parsed.success)
                return reply
                  .code(400)
                  .send({ error: { code: "VALIDATION_ERROR" } });
              return { data: await service.read(customer.id, parsed.data.id) };
            }
            let body: unknown;
            try {
              body = JSON.parse((request.body as Buffer).toString("utf8"));
            } catch {
              return reply
                .code(400)
                .send({ error: { code: "VALIDATION_ERROR" } });
            }
            const parsed = z
              .object({
                request_id: z.string().uuid(),
                source_amount_brl: z.string().max(12).optional(),
                target_amount_usdt: z.string().max(13).optional(),
              })
              .strict()
              .refine(
                (v) =>
                  Boolean(v.source_amount_brl) !==
                  Boolean(v.target_amount_usdt),
              )
              .safeParse(body);
            if (!parsed.success)
              return reply
                .code(400)
                .send({ error: { code: "VALIDATION_ERROR" } });
            const result = await service.create(
              customer.id,
              parsed.data.request_id,
              parsed.data.source_amount_brl ?? parsed.data.target_amount_usdt!,
              parsed.data.target_amount_usdt !== undefined,
            );
            reply.header("Location", `/v1/me/quotes/${result.data.id}`);
            return reply.code(result.replayed ? 200 : 201).send({
              data: result.data,
              meta: {
                idempotent_replay: result.replayed,
                operations_enabled: false,
              },
            });
          } catch (error) {
            if (error instanceof CustomerQuoteError)
              return reply
                .code(
                  error.code === "QUOTE_NOT_FOUND"
                    ? 404
                    : error.code === "QUOTE_AMOUNT_INVALID"
                      ? 400
                      : 409,
                )
                .send({
                  error: {
                    code: error.code,
                    ...(error.quoteId ? { quote_id: error.quoteId } : {}),
                  },
                });
            if (error instanceof CustomerQuoteProviderError)
              return reply.code(502).send({
                error: {
                  code: "QUOTE_PROVIDER_UNAVAILABLE",
                  quote_id: error.quoteId,
                  provider_http_status: error.providerStatus,
                  automatic_retry: false,
                },
              });
            request.log.warn({ event: "customer_quote_unavailable" });
            return reply
              .code(503)
              .send({ error: { code: "CUSTOMER_QUOTE_UNAVAILABLE" } });
          }
        },
      });
  });
}
