export const MIN_SETTLEMENT_WINDOW_MS = 60 * 60 * 1000;

export function hasSafeSettlementWindow(value: string, now = Date.now()) {
  const expiresAt = new Date(value).getTime();
  return Number.isFinite(expiresAt) && expiresAt - now >= MIN_SETTLEMENT_WINDOW_MS;
}
