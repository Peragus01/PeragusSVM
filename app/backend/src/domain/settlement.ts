export const settlementStatuses = [
  "received",
  "attested",
  "submitted",
  "settled",
  "failed",
  "expired",
  "manual_review",
] as const;

export type SettlementStatus = (typeof settlementStatuses)[number];

export interface SettlementRequestPayload {
  requestId: string;
  corridorId: string;
  payerWallet: string;
  recipientWallet: string;
  sourceAmount: string;
  destinationAmount: string;
  expiresAt: string;
}

export interface Settlement {
  id: string;
  requestId: string;
  requestPayloadHash: string;
  requestPayload: SettlementRequestPayload;
  corridorId: string;
  payerWallet: string;
  recipientWallet: string;
  sourceAmount: string;
  destinationAmount: string;
  expiresAt: Date;
  status: SettlementStatus;
  createdAt: Date;
  updatedAt: Date;
}
