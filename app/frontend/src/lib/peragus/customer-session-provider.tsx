import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Context,
  type AuthTokens,
  type CustomerIdentity,
  type OperatorMfaEnrollment,
  type SessionState,
} from "./customer-session-context";
import {
  configured,
  supabaseAuth,
  parseTokens,
  fetchIdentity,
  CustomerSessionError,
} from "./customer-session-auth";
export function CustomerSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState>("unauthenticated");
  const [identity, setIdentity] = useState<CustomerIdentity | null>(null);
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const tokensRef = useRef<AuthTokens | null>(null);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const logout = useCallback(() => {
    const prior = tokensRef.current;
    generation.current++;
    pending.current?.abort();
    tokensRef.current = null;
    setTokens(null);
    setIdentity(null);
    setStatus("unauthenticated");
    // Clear local state first. Best-effort remote refresh-token revocation; never block logout.
    if (prior)
      void supabaseAuth("logout?scope=local", {}, "POST", prior.access_token).catch(() => {});
  }, []);
  const login = useCallback(async (email: string, password: string) => {
    const turn = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setIdentity(null);
    setStatus("loading");
    tokensRef.current = null;
    setTokens(null);
    try {
      const next = parseTokens(
        await supabaseAuth("token?grant_type=password", { email, password }),
      );
      if (generation.current !== turn) return;
      const who = await fetchIdentity(next.access_token, controller.signal);
      if (generation.current !== turn) return;
      tokensRef.current = next;
      setTokens(next);
      setIdentity(who);
      setStatus("authenticated");
    } catch (error) {
      if (generation.current === turn) {
        tokensRef.current = null;
        setTokens(null);
        setIdentity(null);
        setStatus("unauthenticated");
      }
      throw error;
    }
  }, []);
  const reloadIdentity = useCallback(async (signal?: AbortSignal) => {
    const current = tokensRef.current;
    if (!current) throw new CustomerSessionError("AUTH_REQUIRED", "Entre na sua conta.");
    const who = await fetchIdentity(current.access_token, signal);
    if (tokensRef.current === current && !signal?.aborted) setIdentity(who);
  }, []);
  const enrollOperatorMfa = useCallback(async (): Promise<OperatorMfaEnrollment> => {
    const current = tokensRef.current;
    if (!current) throw new CustomerSessionError("AUTH_REQUIRED", "Entre na sua conta.");
    const result = await supabaseAuth(
      "factors",
      { factor_type: "totp", friendly_name: "Peragus Operador" },
      "POST",
      current.access_token,
    );
    const totp = result["totp"];
    const factorId = result["id"];
    const qrCode =
      totp && typeof totp === "object" ? (totp as Record<string, unknown>)["qr_code"] : undefined;
    const secret =
      totp && typeof totp === "object" ? (totp as Record<string, unknown>)["secret"] : undefined;
    if (
      typeof factorId !== "string" ||
      !/^[a-zA-Z0-9-]+$/.test(factorId) ||
      typeof qrCode !== "string" ||
      !qrCode.startsWith("data:image/svg+xml") ||
      qrCode.length > 100_000 ||
      typeof secret !== "string" ||
      !/^[A-Z2-7]{16,128}$/.test(secret)
    )
      throw new CustomerSessionError(
        "MFA_INVALID_RESPONSE",
        "Não foi possível iniciar o cadastro do autenticador.",
      );
    return {
      factorId,
      qrCode,
      secret,
    };
  }, []);
  const verifyOperatorMfaEnrollment = useCallback(async (factorId: string, code: string) => {
    const current = tokensRef.current;
    const turn = generation.current;
    if (!current || !/^[a-zA-Z0-9-]+$/.test(factorId) || !/^[0-9]{6}$/.test(code))
      throw new CustomerSessionError("MFA_REQUIRED", "Informe os seis dígitos do autenticador.");
    const challenge = await supabaseAuth(
      `factors/${factorId}/challenge`,
      {},
      "POST",
      current.access_token,
    );
    if (typeof challenge["id"] !== "string" || !/^[a-zA-Z0-9-]+$/.test(challenge["id"]))
      throw new CustomerSessionError(
        "MFA_INVALID_RESPONSE",
        "Não foi possível iniciar a verificação.",
      );
    const next = parseTokens(
      await supabaseAuth(
        `factors/${factorId}/verify`,
        { challenge_id: challenge["id"], code },
        "POST",
        current.access_token,
      ),
    );
    if (turn !== generation.current || tokensRef.current !== current)
      throw new CustomerSessionError("SESSION_CHANGED", "A sessão mudou. Entre novamente.");
    tokensRef.current = next;
    setTokens(next);
  }, []);
  const verifyOperatorMfa = useCallback(async (code: string) => {
    const current = tokensRef.current;
    const turn = generation.current;
    if (!current || !/^[0-9]{6}$/.test(code))
      throw new CustomerSessionError("MFA_REQUIRED", "Informe os seis dígitos do autenticador.");
    const user = await supabaseAuth("user", {}, "GET", current.access_token);
    const factors = user["factors"];
    const factor = Array.isArray(factors)
      ? factors.find(
          (item) =>
            item &&
            item.factor_type === "totp" &&
            item.status === "verified" &&
            typeof item.id === "string",
        )
      : null;
    if (!factor || !/^[a-zA-Z0-9-]+$/.test(factor.id))
      throw new CustomerSessionError(
        "MFA_REQUIRED",
        "Configure um autenticador para esta conta de operador antes de continuar.",
      );
    const challenge = await supabaseAuth(
      `factors/${factor.id}/challenge`,
      {},
      "POST",
      current.access_token,
    );
    if (typeof challenge["id"] !== "string")
      throw new CustomerSessionError(
        "MFA_INVALID_RESPONSE",
        "Não foi possível iniciar a verificação.",
      );
    const next = parseTokens(
      await supabaseAuth(
        `factors/${factor.id}/verify`,
        {
          challenge_id: challenge["id"],
          code,
        },
        "POST",
        current.access_token,
      ),
    );
    if (turn !== generation.current || tokensRef.current !== current)
      throw new CustomerSessionError("SESSION_CHANGED", "A sessão mudou. Entre novamente.");
    tokensRef.current = next;
    setTokens(next);
  }, []);
  // Refresh in memory only. Reloading the page requires login again; no bearer or
  // refresh tokens are written to browser storage.
  useEffect(() => {
    if (!tokens) return;
    let active = true;
    const timer = setInterval(async () => {
      const current = tokensRef.current;
      if (!current || current.expires_at - Date.now() > 90_000) return;
      const turn = generation.current;
      try {
        const next = parseTokens(
          await supabaseAuth("token?grant_type=refresh_token", {
            refresh_token: current.refresh_token,
          }),
        );
        if (active && turn === generation.current && tokensRef.current === current) {
          tokensRef.current = next;
          setTokens(next);
        }
      } catch {
        if (
          active &&
          turn === generation.current &&
          tokensRef.current === current &&
          current.expires_at < Date.now()
        )
          logout();
      }
    }, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tokens, logout]);
  return (
    <Context.Provider
      value={{
        status,
        identity,
        accessToken: tokens?.access_token ?? null,
        configured,
        login,
        logout,
        enrollOperatorMfa,
        verifyOperatorMfaEnrollment,
        verifyOperatorMfa,
        reloadIdentity,
      }}
    >
      {children}
    </Context.Provider>
  );
}
