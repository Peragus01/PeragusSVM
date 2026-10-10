import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  OzavOfframpInitiationError,
  OzavOfframpSettlementNotFoundError,
} from "../domain/ozav-offramp-intent.js";
import type { OzavOfframpInitiator } from "../application/initiate-ozav-offramp.js";
import type { OzavOfframpReconciliationScheduler } from "../jobs/ozav-offramp-reconciliation.js";
import { OzavClientError } from "../providers/ozav-client.js";

const settlementParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

const initiateOfframpSchema = z
  .object({
    payout_destination_id: z
      .string()
      .regex(/^ozav_pd_[A-Za-z0-9_]+$/)
      .max(128),
  })
  .strict();

export interface OzavOfframpRoutesOptions {
  initiator?: OzavOfframpInitiator | undefined;
  reconciliationScheduler?:
    | OzavOfframpReconciliationScheduler
    | undefined;
}

export async function registerOzavOfframpRoutes(
  app: FastifyInstance,
  options: OzavOfframpRoutesOptions,
): Promise<void> {
  app.post(
    "/v1/settlements/:id/offramp",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");

      const parsedParams = settlementParamsSchema.safeParse(
        request.params,
      );
      const parsedBody = initiateOfframpSchema.safeParse(
        request.body,
      );

      if (!parsedParams.success || !parsedBody.success) {
        return reply.code(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Settlement ID or payout destination is invalid",
          },
        });
      }

      if (!options.initiator) {
        return reply.code(503).send({
          error: {
            code: "OZAV_OFFRAMP_DISABLED",
            message: "OZAV off-ramp initiation is disabled",
          },
        });
      }

      try {
        const result = await options.initiator.execute({
          settlementId: parsedParams.data.id,
          payoutDestinationId:
            parsedBody.data.payout_destination_id,
        });
        const reconciliation =
          result.settlementStatus === "offramping"
          && options.reconciliationScheduler
            ? await options.reconciliationScheduler.schedule({
                settlementId: result.settlementId,
                transferId: result.transferId,
                attempt: 1,
              })
            : null;

        reply.header(
          "Idempotency-Replayed",
          String(result.transferReplayed),
        );

        return reply
          .code(
            result.settlementStatus === "paid_out"
              ? 200
              : 202,
          )
          .send({
            data: {
              settlement_id: result.settlementId,
              settlement_status:
                result.settlementStatus,
              payout_destination_id:
                result.payoutDestinationId,
              quote_id: result.quoteId,
              transfer_id: result.transferId,
              provider_status: result.providerStatus,
              amounts: {
                source: {
                  amount: result.sourceAmountUsdt,
                  currency: "USDT",
                },
                quoted_target: {
                  amount:
                    result.quotedTargetAmountBrl,
                  currency: "BRL",
                },
                transfer_target: {
                  amount:
                    result.transferTargetAmountBrl,
                  currency: "BRL",
                },
              },
            },
            meta: {
              idempotent_replay:
                result.transferReplayed,
              intent_created: result.intentCreated,
              quote_created: result.quoteCreated,
              environment: "test",
              reconciliation,
            },
          });
      } catch (error) {
        if (
          error
            instanceof OzavOfframpSettlementNotFoundError
        ) {
          return reply.code(404).send({
            error: {
              code: "SETTLEMENT_NOT_FOUND",
              message: "Settlement was not found",
            },
          });
        }

        if (error instanceof OzavOfframpInitiationError) {
          return reply.code(409).send({
            error: {
              code: "OZAV_OFFRAMP_NOT_READY",
              message: error.message,
            },
          });
        }

        if (error instanceof OzavClientError) {
          return reply.code(502).send({
            error: {
              code: "OZAV_PROVIDER_ERROR",
              message: "OZAV sandbox request failed",
              retryable: error.retryable,
            },
          });
        }

        throw error;
      }
    },
  );
}
