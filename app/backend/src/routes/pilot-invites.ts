import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PilotInviteError,
  type PilotInviteService,
} from "../invites/pilot-invites.js";
import { OperatorApprovalError } from "../withdrawals/operator-approvals.js";
const reason = z
  .string()
  .trim()
  .min(10)
  .max(300)
  .refine(
    (value) =>
      ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
const name = z
  .string()
  .trim()
  .min(2)
  .max(160)
  .refine(
    (value) =>
      ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
export async function registerPilotInviteRoutes(
  app: FastifyInstance,
  service?: PilotInviteService,
) {
  await app.register(async (scoped) => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 4096 },
      (_request, body, done) => done(null, body),
    );
    scoped.post(
      "/registration/invite/check",
      { bodyLimit: 4096 },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!service)
          return reply
            .code(503)
            .send({ error: { code: "PILOT_INVITES_UNAVAILABLE" } });
        if (Object.keys(request.query as object).length)
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
        let body: unknown;
        try {
          body = JSON.parse((request.body as Buffer).toString("utf8"));
        } catch {
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
        }
        const parsed = z
          .object({
            code: z.string().regex(/^pginv_[A-Za-z0-9_-]{43}$/),
            email: z.email().max(254),
          })
          .strict()
          .safeParse(body);
        if (!parsed.success)
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
        try {
          return {
            data: await service.check(
              parsed.data.code,
              parsed.data.email,
              request.ip,
            ),
          };
        } catch (error) {
          if (
            error instanceof PilotInviteError &&
            error.code === "PILOT_INVITE_RATE_LIMITED"
          )
            return reply
              .header("Retry-After", "900")
              .code(429)
              .send({ error: { code: error.code } });
          if (error instanceof PilotInviteError)
            return reply
              .code(error.code.endsWith("DISABLED") ? 503 : 409)
              .send({ error: { code: error.code } });
          request.log.warn({ event: "invite_validation_unavailable" });
          return reply
            .code(503)
            .send({ error: { code: "PILOT_INVITES_UNAVAILABLE" } });
        }
      },
    );
    for (const [action, method, url] of [
      ["issue", "POST", "/v1/admin/pilot-invites"],
      ["read", "GET", "/v1/admin/pilot-invites/:id"],
      ["revoke", "POST", "/v1/admin/pilot-invites/:id/revoke"],
      ["redeem", "POST", "/v1/me/pilot-invite/redeem"],
    ] as const)
      scoped.route({
        method,
        url,
        bodyLimit: 4096,
        handler: async (request, reply) => {
          reply.header("Cache-Control", "no-store");
          if (!request.authenticatedUser)
            return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
          if (!service)
            return reply
              .code(503)
              .send({ error: { code: "PILOT_INVITES_UNAVAILABLE" } });
          try {
            const user = request.authenticatedUser;
            if (action !== "redeem") service.authorize(user);
            if (Object.keys(request.query as object).length)
              return reply
                .code(400)
                .send({ error: { code: "VALIDATION_ERROR" } });
            const params = z
              .object({ id: z.string().uuid() })
              .safeParse(request.params);
            if ((action === "read" || action === "revoke") && !params.success)
              return reply
                .code(400)
                .send({ error: { code: "VALIDATION_ERROR" } });
            if (action === "read") {
              if (request.body !== undefined)
                return reply
                  .code(400)
                  .send({ error: { code: "VALIDATION_ERROR" } });
              return { data: await service.read(user, params.data!.id) };
            }
            let body: unknown;
            try {
              body = JSON.parse((request.body as Buffer).toString("utf8"));
            } catch {
              return reply
                .code(400)
                .send({ error: { code: "VALIDATION_ERROR" } });
            }
            let result;
            if (action === "issue") {
              const parsed = z
                .object({
                  request_id: z.string().uuid(),
                  target_user_id: z.string().uuid().optional(),
                  target_email: z.email().max(254).optional(),
                  expires_in_hours: z
                    .number()
                    .int()
                    .min(1)
                    .max(168)
                    .default(24),
                  reason,
                })
                .strict()
                .refine(
                  (value) =>
                    Boolean(value.target_user_id) !==
                    Boolean(value.target_email),
                )
                .safeParse(body);
              if (!parsed.success)
                return reply
                  .code(400)
                  .send({ error: { code: "VALIDATION_ERROR" } });
              result = parsed.data.target_email
                ? await service.issueEmail(
                    user,
                    parsed.data.request_id,
                    parsed.data.target_email,
                    parsed.data.expires_in_hours,
                    parsed.data.reason,
                  )
                : await service.issue(
                    user,
                    parsed.data.request_id,
                    parsed.data.target_user_id!,
                    parsed.data.expires_in_hours,
                    parsed.data.reason,
                  );
            } else if (action === "revoke") {
              const parsed = z
                .object({ request_id: z.string().uuid(), reason })
                .strict()
                .safeParse(body);
              if (!parsed.success)
                return reply
                  .code(400)
                  .send({ error: { code: "VALIDATION_ERROR" } });
              result = await service.revoke(
                user,
                params.data!.id,
                parsed.data.request_id,
                parsed.data.reason,
              );
            } else {
              const parsed = z
                .object({
                  request_id: z.string().uuid(),
                  code: z.string().regex(/^pginv_[A-Za-z0-9_-]{43}$/),
                  display_name: name,
                })
                .strict()
                .safeParse(body);
              if (!parsed.success)
                return reply
                  .code(400)
                  .send({ error: { code: "VALIDATION_ERROR" } });
              result = await service.redeem(
                user,
                parsed.data.request_id,
                parsed.data.code,
                parsed.data.display_name,
              );
            }
            return reply.code(result.replayed ? 200 : 201).send({
              data: result.data,
              ...("code" in result ? { code: result.code } : {}),
              meta: {
                idempotent_replay: result.replayed,
                operations_enabled: false,
              },
            });
          } catch (error) {
            if (error instanceof OperatorApprovalError)
              return reply.code(403).send({ error: { code: error.code } });
            if (
              error instanceof PilotInviteError &&
              error.code === "PILOT_INVITE_RATE_LIMITED"
            )
              return reply
                .header("Retry-After", "900")
                .code(429)
                .send({ error: { code: error.code } });
            if (error instanceof PilotInviteError)
              return reply
                .code(
                  error.code.endsWith("DISABLED")
                    ? 503
                    : error.code.endsWith("NOT_FOUND")
                      ? 404
                      : error.code === "PILOT_OPERATOR_NOT_ELIGIBLE"
                        ? 403
                        : 409,
                )
                .send({ error: { code: error.code } });
            request.log.warn({ event: "pilot_invite_unavailable" });
            return reply
              .code(503)
              .send({ error: { code: "PILOT_INVITES_UNAVAILABLE" } });
          }
        },
      });
  });
}
