import { PublicKey } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  CreateSettlementService,
  IdempotencyConflictError,
  SettlementExpiredError,
} from "../application/create-settlement.js";
import type { Settlement } from "../domain/settlement.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

const U64_MAX = 18_446_744_073_709_551_615n;

const positiveU64Schema = z
  .string()
  .regex(/^[1-9][0-9]*$/, "must be a positive integer string")
  .refine((value) => {
    try {
      return BigInt(value) <= U64_MAX;
    } catch {
      return false;
    }
  }, "must fit in an unsigned 64-bit integer");

const solanaPublicKeySchema = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      return new PublicKey(value).toBase58() === value;
    } catch {
      return false;
    }
  }, "must be a valid Solana public key");

const createSettlementSchema = z
  .object({
    request_id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(
        /^[A-Za-z0-9._:-]+$/,
        "contains unsupported characters",
      ),
    corridor_id: z
      .string()
      .regex(
        /^[0-9a-fA-F]{64}$/,
        "must contain exactly 32 bytes encoded as hexadecimal",
      ),
    payer_wallet: solanaPublicKeySchema,
    recipient_wallet: solanaPublicKeySchema,
    source_amount: positiveU64Schema,
    destination_amount: positiveU64Schema,
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

const settlementParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export interface SettlementRoutesOptions {
  repository: SettlementRepository;
  now: () => Date;
}

function serializeSettlement(settlement: Settlement) {
  return {
    id: settlement.id,
    request_id: settlement.requestId,
    corridor_id: settlement.corridorId,
    payer_wallet: settlement.payerWallet,
    recipient_wallet: settlement.recipientWallet,
    source_amount: settlement.sourceAmount,
    destination_amount: settlement.destinationAmount,
    expires_at: settlement.expiresAt.toISOString(),
    status: settlement.status,
    version: settlement.version,
    created_at: settlement.createdAt.toISOString(),
    updated_at: settlement.updatedAt.toISOString(),
  };
}

export async function registerSettlementRoutes(
  app: FastifyInstance,
  options: SettlementRoutesOptions,
): Promise<void> {
  const service = new CreateSettlementService(
    options.repository,
    options.now,
  );

  app.get("/v1/settlements/:id", async (request, reply) => {
    const parsed = settlementParamsSchema.safeParse(
      request.params,
    );

    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Settlement ID is invalid",
        },
      });
    }

    const settlement = await options.repository.findById(
      parsed.data.id,
    );

    if (!settlement) {
      return reply.code(404).send({
        error: {
          code: "SETTLEMENT_NOT_FOUND",
          message: "Settlement was not found",
        },
      });
    }

    return reply.code(200).send({
      data: serializeSettlement(settlement),
    });
  });

  app.post("/v1/settlements", async (request, reply) => {
    const parsed = createSettlementSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body is invalid",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }

    try {
      const result = await service.execute({
        requestId: parsed.data.request_id,
        corridorId: parsed.data.corridor_id,
        payerWallet: parsed.data.payer_wallet,
        recipientWallet: parsed.data.recipient_wallet,
        sourceAmount: parsed.data.source_amount,
        destinationAmount: parsed.data.destination_amount,
        expiresAt: parsed.data.expires_at,
      });

      reply.header(
        "Idempotency-Replayed",
        String(!result.created),
      );

      reply.header(
        "Location",
        `/v1/settlements/${result.settlement.id}`,
      );

      return reply.code(result.created ? 201 : 200).send({
        data: serializeSettlement(result.settlement),
        meta: {
          idempotent_replay: !result.created,
        },
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send({
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message:
              "request_id was already used with a different payload",
          },
        });
      }

      if (error instanceof SettlementExpiredError) {
        return reply.code(422).send({
          error: {
            code: "SETTLEMENT_EXPIRED",
            message: "expires_at must be in the future",
          },
        });
      }

      throw error;
    }
  });
}
