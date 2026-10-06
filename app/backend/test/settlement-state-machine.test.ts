import { describe, expect, it } from "vitest";

import { CreateSettlementService } from "../src/application/create-settlement.js";
import { TransitionSettlementService } from "../src/application/transition-settlement.js";
import {
  InvalidSettlementTransitionError,
} from "../src/domain/settlement-state-machine.js";
import type {
  SettlementRequestPayload,
  SettlementStatus,
} from "../src/domain/settlement.js";
import { InMemorySettlementRepository } from "../src/repositories/in-memory-settlement-repository.js";

const request: SettlementRequestPayload = {
  requestId: "state-machine-1001",
  corridorId: "cd".repeat(32),
  payerWallet: "11111111111111111111111111111112",
  recipientWallet:
    "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
  sourceAmount: "25000000",
  destinationAmount: "37500",
  expiresAt: "2031-01-01T00:00:00.000Z",
};

async function createFixture() {
  const repository = new InMemorySettlementRepository();
  const now = () => new Date("2030-01-01T00:00:00.000Z");

  const created = await new CreateSettlementService(
    repository,
    now,
  ).execute(request);

  const transitions = new TransitionSettlementService(
    repository,
    now,
  );

  return {
    repository,
    settlement: created.settlement,
    transitions,
  };
}

describe("settlement state machine", () => {
  it("completes the full happy-path sequence", async () => {
    const fixture = await createFixture();

    const path: SettlementStatus[] = [
      "awaiting_pix",
      "pix_confirmed",
      "tokenized",
      "settling",
      "settled",
      "offramping",
      "paid_out",
    ];

    let current = fixture.settlement;

    for (const nextStatus of path) {
      current = await fixture.transitions.execute({
        settlementId: current.id,
        nextStatus,
      });
    }

    expect(current.status).toBe("paid_out");
    expect(current.version).toBe(7);
  });

  it("rejects skipping required states", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.transitions.execute({
        settlementId: fixture.settlement.id,
        nextStatus: "settling",
      }),
    ).rejects.toBeInstanceOf(
      InvalidSettlementTransitionError,
    );
  });

  it("keeps terminal states terminal", async () => {
    const fixture = await createFixture();

    const failed = await fixture.transitions.execute({
      settlementId: fixture.settlement.id,
      nextStatus: "failed",
    });

    await expect(
      fixture.transitions.execute({
        settlementId: failed.id,
        nextStatus: "awaiting_pix",
      }),
    ).rejects.toBeInstanceOf(
      InvalidSettlementTransitionError,
    );
  });

  it("rejects a stale optimistic-lock version", async () => {
    const fixture = await createFixture();

    const firstUpdate =
      await fixture.repository.updateStatus({
        id: fixture.settlement.id,
        expectedStatus: "created",
        expectedVersion: 0,
        nextStatus: "awaiting_pix",
        occurredAt: new Date("2030-01-01T00:00:01.000Z"),
      });

    expect(firstUpdate?.version).toBe(1);

    const staleUpdate =
      await fixture.repository.updateStatus({
        id: fixture.settlement.id,
        expectedStatus: "created",
        expectedVersion: 0,
        nextStatus: "failed",
        occurredAt: new Date("2030-01-01T00:00:02.000Z"),
      });

    expect(staleUpdate).toBeNull();
  });
});
