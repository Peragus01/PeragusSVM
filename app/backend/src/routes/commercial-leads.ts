import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

const interests = [
  "Cross-Border Payments",
  "Payment Infrastructure",
  "Liquidity Provider Partnership",
  "Fintech Integration",
  "Strategic Partnership",
  "Other",
] as const;

const text = (max: number) =>
  z.string().trim().min(2).max(max).refine((value) =>
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }),
  );

const lead = z.object({
  fullName: text(120),
  corporateEmail: z.string().trim().max(254).email().transform((value) => value.toLowerCase()),
  company: text(160),
  position: text(120),
  country: text(100),
  website: z.union([z.url({ protocol: /^https?$/ }).max(300), z.literal("")]),
  interest: z.enum(interests),
  fax: z.literal(""),
}).strict();

export function registerCommercialLeadRoute(app: FastifyInstance, pool: Pool) {
  const windowMs = 60_000;
  let resetAt = 0;
  let attempts = 0;
  const attemptsByAddress = new Map<string, number>();

  app.post("/public/commercial-leads", {
    bodyLimit: 4096,
    onRequest: async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const now = Date.now();
      if (now >= resetAt) {
        resetAt = now + windowMs;
        attempts = 0;
        attemptsByAddress.clear();
      }
      const addressAttempts = attemptsByAddress.get(request.ip) ?? 0;
      if (attempts >= 60 || addressAttempts >= 30) {
        return reply.header("Retry-After", Math.ceil((resetAt - now) / 1000))
          .code(429).send({ error: { code: "RATE_LIMITED" } });
      }
      attempts += 1;
      attemptsByAddress.set(request.ip, addressAttempts + 1);
    },
  }, async (request, reply) => {
    const result = lead.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        error: {
          code: "INVALID_LEAD",
          fields: [...new Set(result.error.issues.map((issue) => issue.path[0]).filter(Boolean))],
        },
      });
    }

    const data = result.data;
    try {
      await pool.query(
        `insert into public.commercial_leads
           (full_name, corporate_email, company, position, country, company_website, area_of_interest)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (corporate_email, area_of_interest) do nothing`,
        [data.fullName, data.corporateEmail, data.company, data.position, data.country,
          data.website || null, data.interest],
      );
      return reply.code(200).send({ received: true });
    } catch {
      request.log.error("Commercial lead storage failed");
      return reply.code(503).send({ error: { code: "LEAD_STORAGE_UNAVAILABLE" } });
    }
  });
}
