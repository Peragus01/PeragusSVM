import { useEffect, useState } from "react";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { journeyRequest } from "@/lib/peragus/journey";
import { moneyNetwork, useMoneyMode } from "@/lib/peragus/config";
import type { LinkedWallet } from "./customer-wallet-link";
type WalletStatus = {
  environment: string;
  customer: { id: string };
  operations_enabled: boolean;
  wallet: LinkedWallet | null;
};
export function useLinkedWallet() {
  const { accessToken, identity } = useCustomerSession();
  const mode = useMoneyMode();
  const customerId = identity?.customer?.id;
  const [linked, setLinked] = useState<LinkedWallet | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLinked(null);
    setError("");
    if (!accessToken || !customerId) return;
    void journeyRequest<WalletStatus>(
      accessToken,
      "v1/me/onboarding/status",
      "GET",
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (
          data.environment !== mode ||
          data.customer?.id !== customerId ||
          data.operations_enabled !== false
        )
          throw Error();
        const w = data.wallet;
        if (
          w &&
          w.network === moneyNetwork(mode) &&
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.wallet_address)
        )
          setLinked(w);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Não foi possível confirmar a carteira vinculada.");
      });
    return () => controller.abort();
  }, [accessToken, customerId, mode]);
  return { linked, setLinked, error };
}
