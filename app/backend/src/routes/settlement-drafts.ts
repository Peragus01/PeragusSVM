import type { FastifyInstance } from "fastify";
import { CreateSettlementService, IdempotencyConflictError, SettlementExpiredError } from "../application/create-settlement.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";
import { createSettlementSchema, serializeSettlement } from "./settlements.js";

export async function registerSettlementDraftRoutes(app: FastifyInstance, options: {
  repositoryForCustomer: ((customerId: string) => SettlementRepository) | undefined;
  now: () => Date;
}): Promise<void> {
  // No publisher, wallet funder, provider, or blockchain adapter is passed to this route.
  app.post("/v1/settlement-drafts", async (request, reply) => {
    if (!options.repositoryForCustomer) return reply.code(503).send({ error: {
      code: "SETTLEMENT_DRAFTS_DISABLED", message: "Non-executable settlement records are disabled",
    } });
    const customer = request.authenticatedCustomer;
    if (!customer || customer.suspended) return reply.code(403).send({ error: {
      code: "CUSTOMER_REQUIRED", message: "An active customer profile is required",
    } });
    const parsed = createSettlementSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: {
      code: "VALIDATION_ERROR", message: "Request body is invalid",
    } });
    try {
      const body = parsed.data;
      const result = await new CreateSettlementService(options.repositoryForCustomer(customer.id), options.now).execute({
        requestId: body.request_id, corridorId: body.corridor_id, payerWallet: body.payer_wallet,
        recipientWallet: body.recipient_wallet, sourceAmount: body.source_amount,
        destinationAmount: body.destination_amount, expiresAt: body.expires_at,
      });
      if (!result.settlement.recordOnly || result.settlement.customerId !== customer.id) {
        throw new Error("Draft repository returned an unexpected ownership or execution mode");
      }
      reply.header("Idempotency-Replayed", String(!result.created));
      reply.header("Location", `/v1/settlements/${result.settlement.id}`);
      return reply.code(result.created ? 201 : 200).send({
        data: serializeSettlement(result.settlement),
        meta: { idempotent_replay: !result.created, record_only: true, job_enqueued: false, operations_enabled: false },
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: {
        code: "IDEMPOTENCY_CONFLICT", message: "request_id was already used with a different payload for this customer",
      } });
      if (error instanceof SettlementExpiredError) return reply.code(422).send({ error: {
        code: "SETTLEMENT_EXPIRED", message: "expires_at must be in the future",
      } });
      throw error;
    }
  });
}
