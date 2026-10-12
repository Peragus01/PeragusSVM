import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  OzavOnrampSettlementNotFoundError,
  type OzavOnrampReader,
  type OzavOnrampView,
} from "../application/get-ozav-onramp.js";
import {
  SandboxPixPaymentError,
  type SandboxPixPaymentSimulator,
} from "../application/simulate-sandbox-pix-payment.js";

const settlementParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export interface OzavOnrampRoutesOptions {
  reader?: OzavOnrampReader | undefined;
  sandboxPaymentSimulator?:
    | SandboxPixPaymentSimulator
    | undefined;
  now?: (() => Date) | undefined;
}

function serializeOnramp(
  view: OzavOnrampView,
  now: Date,
) {
  const payment = view.paymentInstructions;
  return {
    settlement_id: view.settlementId,
    settlement_status: view.settlementStatus,
    stage: view.stage,
    ready: view.ready,
    quote_id: view.quoteId,
    transfer_id: view.transferId,
    source_amount_brl: view.sourceAmountBrl,
    quoted_target_amount_usdt:
      view.quotedTargetAmountUsdt,
    pix: payment
      ? {
          expires_at: payment.expiresAt.toISOString(),
          expired:
            payment.expiresAt.getTime() <= now.getTime(),
        }
      : null,
  };
}

export async function registerOzavOnrampRoutes(
  app: FastifyInstance,
  options: OzavOnrampRoutesOptions,
): Promise<void> {
  app.get(
    "/v1/settlements/:id/onramp",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
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
      if (!options.reader) {
        return reply.code(503).send({
          error: {
            code: "ONRAMP_STORAGE_UNAVAILABLE",
            message:
              "Liquidity-rail storage is not configured",
          },
        });
      }
      try {
        const view = await options.reader.execute(
          parsed.data.id,
        );
        return reply
          .code(view.ready ? 200 : 202)
          .send({
            data: serializeOnramp(
              view,
              (options.now ?? (() => new Date()))(),
            ),
          });
      } catch (error) {
        if (
          error
            instanceof OzavOnrampSettlementNotFoundError
        ) {
          return reply.code(404).send({
            error: {
              code: "SETTLEMENT_NOT_FOUND",
              message: "Settlement was not found",
            },
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/settlements/:id/onramp/simulate-payment",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
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
      if (!options.sandboxPaymentSimulator) {
        return reply.code(503).send({
          error: {
            code: "SANDBOX_DEMO_DISABLED",
            message:
              "Sandbox checkout controls are not enabled",
          },
        });
      }

      try {
        const result =
          await options.sandboxPaymentSimulator.execute(
            parsed.data.id,
          );
        return reply.code(202).send({
          data: {
            settlement_id: result.settlementId,
            settlement_status: result.settlementStatus,
            accepted: result.accepted,
            reconciliation_scheduled:
              result.reconciliationScheduled,
          },
          meta: {
            idempotent_replay:
              result.idempotentReplay,
            environment: "sandbox",
          },
        });
      } catch (error) {
        if (error instanceof SandboxPixPaymentError) {
          const statusCode =
            error.code === "SETTLEMENT_NOT_FOUND"
              ? 404
              : error.code
                  === "SANDBOX_PAYMENT_NOT_READY"
                ? 409
                : 502;
          return reply.code(statusCode).send({
            error: {
              code: error.code,
              message:
                error.code === "SETTLEMENT_NOT_FOUND"
                  ? "Settlement was not found"
                  : error.code
                      === "SANDBOX_PAYMENT_NOT_READY"
                    ? "Sandbox payment is not ready"
                    : "Sandbox payment control is temporarily unavailable",
              retryable:
                error.code
                === "SANDBOX_PAYMENT_UNAVAILABLE",
              ...(error.settlementStatus
                ? { status: error.settlementStatus }
                : {}),
            },
          });
        }
        throw error;
      }
    },
  );
}
