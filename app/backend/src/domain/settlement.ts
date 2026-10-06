export const settlementStatuses = [
  "created",
  "awaiting_pix",
  "pix_confirmed",
  "tokenized",
  "settling",
  "settled",
  "offramping",
  "paid_out",
  "failed",
  "revoked",
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
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
