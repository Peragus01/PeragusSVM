export class WithdrawalRequestError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export interface WithdrawalRequest {
  id: string; customerId: string; requestId: string; pixId: string; purchaseId: string;
  amountUsdt: string; walletAddress: string; walletVerifiedAt: string; createdAt: string; approvedAt?: string | null; executionAttempted?: boolean; executionStatus?: string | null;
}
export interface WithdrawalRequestRepository {
  read(customerId: string, id: string): Promise<WithdrawalRequest | null>;
  record(customerId: string, requestId: string, pixId: string): Promise<{record: WithdrawalRequest; replayed: boolean}>;
}
const view = (r: WithdrawalRequest) => ({
  id: r.id, request_id: r.requestId, pix_id: r.pixId, purchase_intent_id: r.purchaseId,
  state: "recorded", environment: "test", record_only: true,
  source: {currency: "USDT", amount: r.amountUsdt, basis: "recorded_completed_conversion"},
  destination: {wallet_address: r.walletAddress, chain: "solana", proof_network: "solana:devnet", verified_at: r.walletVerifiedAt},
  created_at: r.createdAt, manual_approval_required: true, approved: r.approvedAt != null, approval_recorded_at: r.approvedAt ?? null,
  provider_freshness_evaluated: false, balance_reserved: false,
  delivery_costs_evaluated: false, net_delivery_amount: null,
  withdrawal_started: r.executionAttempted === true, sandbox_execution_status: r.executionStatus ?? null, onchain_delivery_verified: false, job_enqueued: false, operations_enabled: false,
});
/** Local read/record only: intentionally has no provider, signer or queue dependency. */
export class CustomerWithdrawalRequestService {
  constructor(private readonly repository: WithdrawalRequestRepository) {}
  async read(customerId: string, id: string) {
    const row = await this.repository.read(customerId, id);
    if (!row) throw new WithdrawalRequestError("WITHDRAWAL_REQUEST_NOT_FOUND");
    return view(row);
  }
  async record(customerId: string, requestId: string, pixId: string) {
    const result = await this.repository.record(customerId, requestId, pixId);
    return {data: view(result.record), replayed: result.replayed};
  }
}
