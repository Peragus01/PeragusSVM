import type { SettlementStatus } from "../domain/settlement.js";
import type { OzavReconciliationScheduler } from "../jobs/ozav-reconciliation.js";
import type { OzavOnrampRepository } from "../repositories/ozav-onramp-repository.js";
import type { SettlementRepository } from "../repositories/settlement-repository.js";

export type SandboxPixPaymentErrorCode =
  | "SETTLEMENT_NOT_FOUND"
  | "SANDBOX_PAYMENT_NOT_READY"
  | "SANDBOX_PAYMENT_UNAVAILABLE";

export class SandboxPixPaymentError extends Error {
  constructor(
    readonly code: SandboxPixPaymentErrorCode,
    readonly settlementStatus?: SettlementStatus,
  ) {
    super(code);
    this.name = "SandboxPixPaymentError";
  }
}

export interface SandboxTransferSimulator {
  getTransfer(id: string): Promise<{ status: string }>;
  simulateTransfer(id: string): Promise<void>;
}

export interface SandboxPixPaymentResult {
  settlementId: string;
  settlementStatus: SettlementStatus;
  accepted: true;
  idempotentReplay: boolean;
  reconciliationScheduled: boolean;
}

export interface SandboxPixPaymentSimulator {
  execute(
    settlementId: string,
  ): Promise<SandboxPixPaymentResult>;
}

const ALREADY_PAID = new Set<SettlementStatus>([
  "pix_confirmed",
  "tokenized",
  "settling",
  "settled",
  "offramping",
  "paid_out",
]);

/**
 * Demo-only adapter. It changes no settlement state directly: the existing
 * reconciliation worker remains the sole owner of persisted transitions and
 * contingency-reserve resolution.
 */
export class SimulateSandboxPixPaymentService
  implements SandboxPixPaymentSimulator
{
  private readonly inFlight = new Map<
    string,
    Promise<SandboxPixPaymentResult>
  >();

  constructor(
    private readonly dependencies: {
      settlements: Pick<
        SettlementRepository,
        "findById"
      >;
      onramps: Pick<
        OzavOnrampRepository,
        "findBinding"
      >;
      client: SandboxTransferSimulator;
      reconciliationScheduler:
        OzavReconciliationScheduler;
    },
  ) {}

  async execute(
    settlementId: string,
  ): Promise<SandboxPixPaymentResult> {
    const existing = this.inFlight.get(settlementId);
    if (existing) {
      const result = await existing;
      return { ...result, idempotentReplay: true };
    }

    const operation = this.run(settlementId);
    this.inFlight.set(settlementId, operation);

    try {
      return await operation;
    } finally {
      this.inFlight.delete(settlementId);
    }
  }

  private async run(
    settlementId: string,
  ): Promise<SandboxPixPaymentResult> {
    const settlement =
      await this.dependencies.settlements.findById(
        settlementId,
      );

    if (!settlement) {
      throw new SandboxPixPaymentError(
        "SETTLEMENT_NOT_FOUND",
      );
    }

    if (ALREADY_PAID.has(settlement.status)) {
      return {
        settlementId,
        settlementStatus: settlement.status,
        accepted: true,
        idempotentReplay: true,
        reconciliationScheduled: false,
      };
    }

    if (settlement.status !== "awaiting_pix") {
      throw new SandboxPixPaymentError(
        "SANDBOX_PAYMENT_NOT_READY",
        settlement.status,
      );
    }

    const binding =
      await this.dependencies.onramps.findBinding(
        settlementId,
      );
    if (!binding) {
      throw new SandboxPixPaymentError(
        "SANDBOX_PAYMENT_NOT_READY",
        settlement.status,
      );
    }

    try {
      const transfer =
        await this.dependencies.client.getTransfer(
          binding.transferId,
        );
      const idempotentReplay =
        transfer.status !== "awaiting_payment";

      if (!idempotentReplay) {
        await this.dependencies.client.simulateTransfer(
          binding.transferId,
        );
      }

      // Attempt zero is reserved for the user-triggered demo action. Normal
      // background reconciliation starts at attempt one.
      const scheduled =
        await this.dependencies.reconciliationScheduler
          .schedule(
            {
              settlementId,
              requestId: settlement.requestId,
              attempt: 0,
            },
            { immediate: true },
          );

      return {
        settlementId,
        settlementStatus: settlement.status,
        accepted: true,
        idempotentReplay,
        reconciliationScheduled: scheduled.scheduled,
      };
    } catch (error) {
      if (error instanceof SandboxPixPaymentError) {
        throw error;
      }
      throw new SandboxPixPaymentError(
        "SANDBOX_PAYMENT_UNAVAILABLE",
        settlement.status,
      );
    }
  }
}
