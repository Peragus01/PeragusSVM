import {
  createHash,
  randomUUID,
} from "node:crypto";

import type {
  Settlement,
  SettlementRequestPayload,
} from "../domain/settlement.js";
import type {
  CreateOrGetSettlementResult,
  SettlementRepository,
} from "../repositories/settlement-repository.js";

export class IdempotencyConflictError extends Error {
  constructor(public readonly requestId: string) {
    super(
      `request_id ${requestId} was already used with a different payload`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export class SettlementExpiredError extends Error {
  constructor() {
    super("Settlement expiration must be in the future");
    this.name = "SettlementExpiredError";
  }
}

function normalizePayload(
  input: SettlementRequestPayload,
): SettlementRequestPayload {
  return {
    requestId: input.requestId,
    corridorId: input.corridorId.toLowerCase(),
    payerWallet: input.payerWallet,
    recipientWallet: input.recipientWallet,
    sourceAmount: BigInt(input.sourceAmount).toString(),
    destinationAmount: BigInt(input.destinationAmount).toString(),
    expiresAt: new Date(input.expiresAt).toISOString(),
  };
}

function fingerprintPayload(
  payload: SettlementRequestPayload,
): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export class CreateSettlementService {
  constructor(
    private readonly repository: SettlementRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    input: SettlementRequestPayload,
  ): Promise<CreateOrGetSettlementResult> {
    const payload = normalizePayload(input);
    const requestPayloadHash = fingerprintPayload(payload);

    const existing =
      await this.repository.findByRequestId(
        payload.requestId,
      );

    if (existing) {
      if (
        existing.requestPayloadHash
        !== requestPayloadHash
      ) {
        throw new IdempotencyConflictError(
          payload.requestId,
        );
      }

      return {
        settlement: existing,
        created: false,
      };
    }

    const timestamp = this.now();
    const expiresAt = new Date(payload.expiresAt);

    if (expiresAt.getTime() <= timestamp.getTime()) {
      throw new SettlementExpiredError();
    }

    const candidate: Settlement = {
      id: randomUUID(),
      requestId: payload.requestId,
      requestPayloadHash,
      requestPayload: payload,
      corridorId: payload.corridorId,
      payerWallet: payload.payerWallet,
      recipientWallet: payload.recipientWallet,
      sourceAmount: payload.sourceAmount,
      destinationAmount: payload.destinationAmount,
      expiresAt,
      status: "created",
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const result = await this.repository.createOrGet(candidate);

    if (
      result.settlement.requestPayloadHash
      !== requestPayloadHash
    ) {
      throw new IdempotencyConflictError(payload.requestId);
    }

    return result;
  }
}
