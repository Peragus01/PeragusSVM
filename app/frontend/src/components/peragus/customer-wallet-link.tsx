import { useEffect, useRef, useState } from "react";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { usePeragusWallet } from "./wallet-context";
import { CustomerNotice } from "./customer-ui";
import { journeyRequest, journeyMessage } from "@/lib/peragus/journey";
export type LinkedWallet = { wallet_address: string; network: "solana:devnet" };
export function useLinkedWallet() {
  const { accessToken, identity } = useCustomerSession();
  const [linked, setLinked] = useState<LinkedWallet | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLinked(null);
    setError("");
    if (!accessToken || !identity?.customer) return;
    void journeyRequest<any>(
      accessToken,
      "v1/me/onboarding/status",
      "GET",
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (
          data.environment !== "test" ||
          data.customer?.id !== identity.customer?.id ||
          data.operations_enabled !== false
        )
          throw Error();
        const w = data.wallet;
        if (
          w &&
          w.network === "solana:devnet" &&
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.wallet_address)
        )
          setLinked(w);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Não foi possível confirmar a carteira vinculada.");
      });
    return () => controller.abort();
  }, [accessToken, identity?.customer?.id]);
  return { linked, setLinked, error };
}
export function CustomerWalletLink({
  onLinked,
}: { onLinked?: (wallet: LinkedWallet) => void } = {}) {
  const wallet = usePeragusWallet();
  const { accessToken, identity } = useCustomerSession();
  const { linked, setLinked, error: readError } = useLinkedWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    setBusy(false);
    return () => {
      epoch.current++;
    };
  }, [accessToken]);
  async function prove() {
    if (lock.current || !accessToken || !wallet.address) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const turn = epoch.current,
      address = wallet.address;
    try {
      const c = await journeyRequest<any>(accessToken, "v1/me/wallet/challenge", "POST", {
        wallet_address: address,
      });
      if (epoch.current !== turn) return;
      if (
        c.environment !== "test" ||
        c.network !== "solana:devnet" ||
        c.wallet_address !== address ||
        c.domain !== "peragussvm-staging.up.railway.app" ||
        typeof c.message !== "string" ||
        !c.message.startsWith(
          `${c.domain} requests proof of control of this Solana wallet:\n${address}\n`,
        ) ||
        Date.parse(c.expires_at) <= Date.now()
      )
        throw Error();
      const signature = await wallet.signMessage(new TextEncoder().encode(c.message));
      if (epoch.current !== turn) return;
      const result = await journeyRequest<any>(accessToken, "v1/me/wallet/confirm", "POST", {
        challenge_id: c.challenge_id,
        signature_base64: btoa(String.fromCharCode(...signature)),
      });
      if (epoch.current !== turn) return;
      if (
        result.environment !== "test" ||
        result.network !== "solana:devnet" ||
        result.wallet_address !== address
      )
        throw Error();
      setLinked(result);
      onLinked?.(result);
    } catch (e) {
      if (epoch.current === turn) setError(journeyMessage(e));
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div>
      <div className="customer-row">
        <span>Carteira vinculada à conta</span>
        <b className="premium-address">{linked?.wallet_address ?? "Não confirmada"}</b>
      </div>
      <div className="customer-row">
        <span>Conectada neste navegador</span>
        <b className="premium-address">{wallet.address ?? "Não conectada"}</b>
      </div>
      <button
        type="button"
        className="customer-button-secondary customer-wallet-action"
        onClick={wallet.open}
      >
        Conectar carteira
      </button>
      {wallet.address && !linked && (
        <button
          className="customer-button"
          type="button"
          disabled={busy || !identity?.customer}
          onClick={() => void prove()}
        >
          {busy ? "Conferindo assinatura…" : "Comprovar titularidade"}
        </button>
      )}
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {readError && <p className="customer-muted">{readError}</p>}
      <p className="customer-muted">
        Rede de testes Solana Devnet. A assinatura comprova controle do endereço e não autoriza
        pagamentos. Um endereço já vinculado não é substituído por esta tela.
      </p>
    </div>
  );
}
