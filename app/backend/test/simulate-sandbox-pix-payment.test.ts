import { describe, expect, it, vi } from "vitest";

import {
  SandboxPixPaymentError,
  SimulateSandboxPixPaymentService,
} from "../src/application/simulate-sandbox-pix-payment.js";
import type { Settlement } from "../src/domain/settlement.js";

const settlementId =
  "00000000-0000-4000-8000-000000000001";

function settlement(
  status: Settlement["status"] = "awaiting_pix",
): Settlement {
  return {
    id: settlementId,
    requestId: "acq-sandbox-checkout",
    requestPayloadHash: "a".repeat(64),
    requestPayload: {
      requestId: "acq-sandbox-checkout",
      corridorId: "ab".repeat(32),
      payerWallet:
        "11111111111111111111111111111112",
      recipientWallet:
        "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
      sourceAmount: "500000000",
      destinationAmount: "89550000",
      expiresAt: "2026-10-12T02:00:00.000Z",
    },
    corridorId: "ab".repeat(32),
    payerWallet: "11111111111111111111111111111112",
    recipientWallet:
      "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
    sourceAmount: "500000000",
    destinationAmount: "89550000",
    expiresAt: new Date("2026-10-12T02:00:00.000Z"),
    status,
    version: 1,
    createdAt: new Date("2026-10-12T00:00:00.000Z"),
    updatedAt: new Date("2026-10-12T00:01:00.000Z"),
  };
}

function setup(
  status: Settlement["status"] = "awaiting_pix",
) {
  const simulateTransfer = vi.fn(
    async () => undefined,
  );
  const schedule = vi.fn(async () => ({
    jobId: "demo-job",
    attempt: 0,
    scheduled: true,
    exhausted: false,
  }));
  const subject =
    new SimulateSandboxPixPaymentService({
      settlements: {
        async findById(id) {
          return id === settlementId
            ? settlement(status)
            : null;
        },
      },
      onramps: {
        async findBinding() {
          return {
            settlementId,
            transferId: "ozav_tr_demo",
            customerId: "ozav_cus_demo",
            walletId: "ozav_wal_demo",
            quoteId: "ozav_q_demo",
          };
        },
      },
      client: {
        async getTransfer() {
          return { status: "awaiting_payment" };
        },
        simulateTransfer,
      },
      reconciliationScheduler: { schedule },
    });
  return { subject, simulateTransfer, schedule };
}

describe("sandbox Pix payment simulation", () => {
  it("simulates only the sandbox and wakes normal reconciliation", async () => {
    const { subject, simulateTransfer, schedule } =
      setup();

    await expect(subject.execute(settlementId)).resolves
      .toMatchObject({
        settlementId,
        settlementStatus: "awaiting_pix",
        accepted: true,
        idempotentReplay: false,
        reconciliationScheduled: true,
      });
    expect(simulateTransfer).toHaveBeenCalledWith(
      "ozav_tr_demo",
    );
    expect(schedule).toHaveBeenCalledWith(
      {
        settlementId,
        requestId: "acq-sandbox-checkout",
        attempt: 0,
      },
      { immediate: true },
    );
  });

  it("does not simulate again after settlement advances", async () => {
    const { subject, simulateTransfer, schedule } =
      setup("tokenized");

    await expect(subject.execute(settlementId)).resolves
      .toMatchObject({
        idempotentReplay: true,
        reconciliationScheduled: false,
      });
    expect(simulateTransfer).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("refuses payment before instructions are ready", async () => {
    const { subject, simulateTransfer } =
      setup("created");
    const error = await subject.execute(settlementId)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(
      SandboxPixPaymentError,
    );
    expect(error).toMatchObject({
      code: "SANDBOX_PAYMENT_NOT_READY",
      settlementStatus: "created",
    });
    expect(simulateTransfer).not.toHaveBeenCalled();
  });
});
