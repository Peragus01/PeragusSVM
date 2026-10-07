import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  SolanaSettlementExpiredError,
  SolanaSettlementNotFoundError,
  SolanaSettlementNotReadyError,
  type SolanaSettlementPreparer,
} from "../application/prepare-solana-settlement.js";

const settlementParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export interface SolanaSettlementRoutesOptions {
  preparer?: SolanaSettlementPreparer | undefined;
}

export async function registerSolanaSettlementRoutes(
  app: FastifyInstance,
  options: SolanaSettlementRoutesOptions,
): Promise<void> {
  app.post(
    "/v1/settlements/:id/solana/prepare",
    async (request, reply) => {
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

      if (!options.preparer) {
        return reply.code(503).send({
          error: {
            code: "SOLANA_COSIGNING_DISABLED",
            message:
              "Solana transaction preparation is disabled",
          },
        });
      }

      try {
        const result = await options.preparer.execute(
          parsed.data.id,
        );

        reply.header("Cache-Control", "no-store");
        reply.header(
          "Idempotency-Replayed",
          String(result.idempotentReplay),
        );

        return reply.code(200).send({
          data: {
            settlement_id: result.settlementId,
            settlement_pda: result.settlementPda,
            corridor_pda: result.corridorPda,
            config_pda: result.configPda,
            transaction_base64: result.transactionBase64,
            message_hash: result.messageHash,
            fee_payer: result.feePayer,
            required_external_signer:
              result.requiredExternalSigner,
            recent_blockhash: result.recentBlockhash,
            last_valid_block_height:
              result.lastValidBlockHeight,
          },
          meta: {
            idempotent_replay: result.idempotentReplay,
            transaction_format: "solana-legacy-base64",
            broadcast_by: "acquirer",
          },
        });
      } catch (error) {
        if (error instanceof SolanaSettlementNotFoundError) {
          return reply.code(404).send({
            error: {
              code: "SETTLEMENT_NOT_FOUND",
              message: "Settlement was not found",
            },
          });
        }

        if (error instanceof SolanaSettlementNotReadyError) {
          return reply.code(409).send({
            error: {
              code: "SETTLEMENT_NOT_TOKENIZED",
              message:
                "Settlement must be tokenized before Solana preparation",
              status: error.status,
            },
          });
        }

        if (error instanceof SolanaSettlementExpiredError) {
          return reply.code(422).send({
            error: {
              code: "SETTLEMENT_EXPIRED",
              message: "Settlement authorization has expired",
            },
          });
        }

        throw error;
      }
    },
  );
}
