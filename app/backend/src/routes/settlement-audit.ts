import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  SettlementAuditNotFoundError,
  type SettlementAuditEvent,
  type SettlementAuditReader,
  type SettlementAuditView,
} from "../application/get-settlement-audit.js";

const settlementParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export interface SettlementAuditRoutesOptions {
  reader?: SettlementAuditReader | undefined;
}

function serializeEvent(event: SettlementAuditEvent) {
  return {
    event_id: event.eventId,
    event_type: event.eventType,
    occurred_at: event.occurredAt,
    content_hash: event.contentHash,
    provider_status: event.providerStatus,
    source_leg_status: event.sourceLegStatus,
    destination_leg_status: event.destinationLegStatus,
    amounts: {
      source: {
        amount: event.sourceAmount,
        currency: event.sourceCurrency,
      },
      target: {
        amount: event.targetAmount,
        currency: event.targetCurrency,
      },
    },
  };
}

export function serializeSettlementAudit(
  view: SettlementAuditView,
) {
  return {
    generated_at: view.generatedAt.toISOString(),
    settlement: {
      id: view.settlement.id,
      request_id: view.settlement.requestId,
      corridor_id: view.settlement.corridorId,
      status: view.settlement.status,
      version: view.settlement.version,
      source_amount_base_units:
        view.settlement.sourceAmountBaseUnits,
      destination_amount_base_units:
        view.settlement.destinationAmountBaseUnits,
      expires_at: view.settlement.expiresAt.toISOString(),
      created_at: view.settlement.createdAt.toISOString(),
      updated_at: view.settlement.updatedAt.toISOString(),
    },
    onramp: view.onramp
      ? {
          transfer_id: view.onramp.transferId,
          quote_id: view.onramp.quoteId,
          provider_status: view.onramp.providerStatus,
          source_leg_status: view.onramp.sourceLegStatus,
          destination_leg_status:
            view.onramp.destinationLegStatus,
          source_amount_brl: view.onramp.sourceAmountBrl,
          target_amount_usdt:
            view.onramp.targetAmountUsdt,
          pix_expires_at:
            view.onramp.pixExpiresAt?.toISOString() ?? null,
          created_at:
            view.onramp.createdAt?.toISOString() ?? null,
          updated_at:
            view.onramp.updatedAt?.toISOString() ?? null,
          identity_consistent:
            view.onramp.identityConsistent,
          event_count: view.onramp.events.length,
          events: view.onramp.events.map(serializeEvent),
        }
      : null,
    contingency_reserve: view.contingencyReserve
      ? {
          status: view.contingencyReserve.status,
          reserve_pda: view.contingencyReserve.reservePda,
          vault_pda: view.contingencyReserve.vaultPda,
          amount_usdt: view.contingencyReserve.amountUsdt,
          amount_base_units:
            view.contingencyReserve.amountBaseUnits,
          fallback_after:
            view.contingencyReserve.fallbackAfter
              .toISOString(),
          expires_at:
            view.contingencyReserve.expiresAt.toISOString(),
          create_signature:
            view.contingencyReserve.createSignature,
          resolution_action:
            view.contingencyReserve.resolutionAction,
          resolution_signature:
            view.contingencyReserve.resolutionSignature,
          version: view.contingencyReserve.version,
          created_at:
            view.contingencyReserve.createdAt.toISOString(),
          updated_at:
            view.contingencyReserve.updatedAt.toISOString(),
        }
      : null,
    solana_settlement: view.solanaSettlement
      ? {
          settlement_pda:
            view.solanaSettlement.settlementPda,
          create_signature:
            view.solanaSettlement.createSignature,
          execute_signature:
            view.solanaSettlement.executeSignature,
          atomic_signature:
            view.solanaSettlement.atomicSignature,
          verified: view.solanaSettlement.verified,
        }
      : null,
    offramp: view.offramp
      ? {
          transfer_id: view.offramp.transferId,
          quote_id: view.offramp.quoteId,
          payout_destination_id:
            view.offramp.payoutDestinationId,
          provider_status: view.offramp.providerStatus,
          source_leg_status:
            view.offramp.sourceLegStatus,
          destination_leg_status:
            view.offramp.destinationLegStatus,
          source_amount_usdt:
            view.offramp.sourceAmountUsdt,
          quoted_target_amount_brl:
            view.offramp.quotedTargetAmountBrl,
          transfer_target_amount_brl:
            view.offramp.transferTargetAmountBrl,
          created_at: view.offramp.createdAt.toISOString(),
          updated_at: view.offramp.updatedAt.toISOString(),
          identity_consistent:
            view.offramp.identityConsistent,
          event_count: view.offramp.events.length,
          events: view.offramp.events.map(serializeEvent),
        }
      : null,
    checks: {
      onramp_completed: view.checks.onrampCompleted,
      reserve_resolved: view.checks.reserveResolved,
      solana_transaction_recorded:
        view.checks.solanaTransactionRecorded,
      offramp_completed: view.checks.offrampCompleted,
      settlement_paid_out:
        view.checks.settlementPaidOut,
      evidence_complete: view.checks.evidenceComplete,
    },
    warnings: view.warnings,
  };
}

export async function registerSettlementAuditRoutes(
  app: FastifyInstance,
  options: SettlementAuditRoutesOptions,
): Promise<void> {
  app.get(
    "/v1/settlements/:id/audit",
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
            code: "AUDIT_STORAGE_UNAVAILABLE",
            message:
              "Settlement audit storage is not configured",
          },
        });
      }

      try {
        const view = await options.reader.execute(
          parsed.data.id,
        );

        return reply.code(200).send({
          data: serializeSettlementAudit(view),
        });
      } catch (error) {
        if (error instanceof SettlementAuditNotFoundError) {
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
}
