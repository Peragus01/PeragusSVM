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
  refreshSession,
  fetchIdentity,
  fetchOperatorStatus,
  CustomerSessionError,
} from "./customer-session-auth";
import {
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
} from "./customer-session-storage";

// Refresh this long before the access token expires; retry transient failures after 15 s.
const refreshSkewMs = 60_000;
const refreshRetryMs = 15_000;
// Never schedule the proactive refresh sooner than this (short-lived tokens must not loop).
export const refreshFloorMs = 10_000;

const operatorMfaFriendlyName = "Peragus Operador";
// GoTrue renders each QR module as SVG markup; keep a bounded limit that fits
// production TOTP payloads without accepting arbitrarily large responses.
const maxTotpQrResponseLength = 1_000_000;

function totpQrCodeDataUrl(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxTotpQrResponseLength)
    return null;
  if (value.startsWith("data:image/svg+xml")) return value;
  // GoTrue returns the generated SVG directly. Depending on the deployed SVG
  // encoder version, it can include an XML declaration before the root node.
  // Keep only the SVG document instead of rejecting a valid response or
  // carrying arbitrary prefix/suffix bytes into the data URL.
  const svgStart = value.indexOf("<svg");
  const svgEnd = value.lastIndexOf("</svg>");
  if (svgStart < 0 || svgEnd < svgStart) return null;
  const svg = value.slice(svgStart, svgEnd + "</svg>".length);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function totpManualSecret(value: unknown) {
  if (typeof value !== "string") return null;
  const secret = value.trim().replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  return /^[A-Z2-7]{16,256}$/.test(secret) ? secret : null;
}

export function CustomerSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState>("unauthenticated");
  const [identity, setIdentity] = useState<CustomerIdentity | null>(null);
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const tokensRef = useRef<AuthTokens | null>(null);
  // True until the one-time restore from sessionStorage finishes, so guards do not
  // redirect to /login while a stored session is being validated.
  const [restoring, setRestoring] = useState(true);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);
  const restoreStarted = useRef(false);
  const logout = useCallback(() => {
    const prior = tokensRef.current;
    generation.current++;
    pending.current?.abort();
    refreshing.current = null;
    clearStoredSession();
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
    refreshing.current = null;
    clearStoredSession();
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
  // Single-flight refresh shared by the proactive timer, restore, 401 retries and any
  // consumer. The refreshed token keeps whatever AAL Supabase returns (never cached/faked).
  const refreshAccessToken = useCallback((): Promise<string | null> => {
    if (refreshing.current) return refreshing.current;
    const base = tokensRef.current;
    if (!base) return Promise.resolve(null);
    const turn = generation.current;
    const flight: { promise: Promise<string | null> | null } = { promise: null };
    flight.promise = (async (): Promise<string | null> => {
      try {
        const next = await refreshSession(base.refresh_token);
        if (generation.current !== turn) return null;
        // Fresh-MFA re-verify may have replaced the tokens meanwhile; keep the newer ones.
        if (tokensRef.current !== base) return tokensRef.current?.access_token ?? null;
        tokensRef.current = next;
        setTokens(next);
        // The refresh token rotated: persist it now, so a reload before the identity effect
        // runs never restores the consumed (now invalid) refresh token.
        const stored = loadStoredSession();
        if (stored) saveStoredSession({ ...next, user: stored.user });
        return next.access_token;
      } catch (error) {
        if (generation.current !== turn) return null;
        const rejected = error instanceof CustomerSessionError && error.code === "AUTH_REJECTED";
        // A rejected refresh token ends the session; a transient outage only does once expired.
        if (rejected || base.expires_at <= Date.now()) logout();
        return null;
      } finally {
        if (refreshing.current === flight.promise) refreshing.current = null;
      }
    })();
    refreshing.current = flight.promise;
    return flight.promise;
  }, [logout]);
  // Calls fetchIdentity and, on a 401, refreshes once and retries with the new token.
  const identityWithRetry = useCallback(
    async (signal?: AbortSignal) => {
      const current = tokensRef.current;
      if (!current) throw new CustomerSessionError("AUTH_REQUIRED", "Entre na sua conta.");
      try {
        return await fetchIdentity(current.access_token, signal);
      } catch (error) {
        if (!(error instanceof CustomerSessionError) || error.code !== "IDENTITY_401") throw error;
        const token = await refreshAccessToken();
        if (!token) throw error;
        return await fetchIdentity(token, signal);
      }
    },
    [refreshAccessToken],
  );
  const reloadIdentity = useCallback(
    async (signal?: AbortSignal) => {
      const current = tokensRef.current;
      if (!current) throw new CustomerSessionError("AUTH_REQUIRED", "Entre na sua conta.");
      const turn = generation.current;
      const who = await identityWithRetry(signal);
      if (tokensRef.current && generation.current === turn && !signal?.aborted) setIdentity(who);
    },
    [identityWithRetry],
  );
  const enrollOperatorMfa = useCallback(async (): Promise<OperatorMfaEnrollment> => {
    const current = tokensRef.current;
    if (!current) throw new CustomerSessionError("AUTH_REQUIRED", "Entre na sua conta.");
    // MFA enrollment exists only for allowlisted operators (the backend decides).
    if (!(await fetchOperatorStatus(current.access_token)))
      throw new CustomerSessionError(
        "OPERATOR_REQUIRED",
        "Esta conta não é de operador; o cadastro de autenticador não está disponível.",
      );

    // Supabase keeps an enrollment as an unverified factor when the page is
    // closed or the client rejects the one-time QR response. Starting over is
    // intentional here: remove only incomplete TOTP factors and never touch a
    // verified authenticator.
    const user = await supabaseAuth("user", {}, "GET", current.access_token);
    const factors = Array.isArray(user["factors"]) ? user["factors"] : [];
    const verifiedTotp = factors.find(
      (factor) =>
        factor &&
        typeof factor === "object" &&
        (factor as Record<string, unknown>)["factor_type"] === "totp" &&
        (factor as Record<string, unknown>)["status"] === "verified",
    );
    if (verifiedTotp)
      throw new CustomerSessionError(
        "MFA_ALREADY_ENROLLED",
        "Este operador já possui um autenticador. Informe o código abaixo.",
      );
    for (const factor of factors) {
      if (!factor || typeof factor !== "object") continue;
      const item = factor as Record<string, unknown>;
      if (
        item["factor_type"] === "totp" &&
        item["status"] === "unverified" &&
        typeof item["id"] === "string" &&
        /^[a-zA-Z0-9-]+$/.test(item["id"])
      )
        await supabaseAuth(`factors/${item["id"]}`, {}, "DELETE", current.access_token);
    }

    const result = await supabaseAuth(
      "factors",
      { factor_type: "totp", friendly_name: operatorMfaFriendlyName },
      "POST",
      current.access_token,
    );
    const totp = result["totp"];
    const factorId = result["id"];
    const qrCode = totpQrCodeDataUrl(
      totp && typeof totp === "object" ? (totp as Record<string, unknown>)["qr_code"] : undefined,
    );
    const secret = totpManualSecret(
      totp && typeof totp === "object" ? (totp as Record<string, unknown>)["secret"] : undefined,
    );
    if (typeof factorId !== "string" || !/^[a-zA-Z0-9-]+$/.test(factorId) || !qrCode)
      throw new CustomerSessionError(
        "MFA_INVALID_QR_RESPONSE",
        "O autenticador foi iniciado, mas o QR code retornado é inválido.",
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
  // A new challenge/verify also on an AAL2 session: GoTrue upserts the session's totp
  // AMR claim (updated_at = now) and issues a token whose amr totp timestamp is fresh.
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
    return next.access_token;
  }, []);
  // Persist what is needed to restore the session in this tab (sessionStorage only).
  useEffect(() => {
    if (tokens && identity) saveStoredSession({ ...tokens, user: identity.user });
  }, [tokens, identity]);
  // One-time restore after a reload: refresh if (almost) expired, validate via /me,
  // retrying once through a refresh on a 401.
  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;
    const saved = loadStoredSession();
    if (!saved) {
      setRestoring(false);
      return;
    }
    const turn = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    tokensRef.current = {
      access_token: saved.access_token,
      refresh_token: saved.refresh_token,
      expires_at: saved.expires_at,
    };
    let refreshed = false;
    void (async () => {
      try {
        if (saved.expires_at - Date.now() <= refreshSkewMs) {
          refreshed = true;
          if (!(await refreshAccessToken()))
            throw new CustomerSessionError("AUTH_REQUIRED", "Entre na sua conta.");
        }
        const who = await identityWithRetry(controller.signal);
        if (generation.current !== turn || !tokensRef.current) return;
        setTokens(tokensRef.current);
        setIdentity(who);
        setStatus("authenticated");
      } catch (error) {
        if (generation.current !== turn) return; // logout()/login() already took over
        tokensRef.current = null;
        // A restore that already attempted a refresh leaves nothing reusable in storage.
        if (
          refreshed ||
          (error instanceof CustomerSessionError && error.code.startsWith("IDENTITY_4"))
        )
          clearStoredSession();
        setTokens(null);
        setIdentity(null);
        setStatus("unauthenticated");
      } finally {
        setRestoring(false);
      }
    })();
  }, [refreshAccessToken, identityWithRetry]);
  // Proactive refresh shortly before expiry; retry while a transient outage persists.
  useEffect(() => {
    if (!tokens) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      timer = setTimeout(
        () => {
          void refreshAccessToken().then((next) => {
            if (active && !next && tokensRef.current === tokens) schedule(refreshRetryMs);
          });
        },
        Math.min(delay, 2_147_000_000),
      );
    };
    schedule(Math.max(refreshFloorMs, tokens.expires_at - refreshSkewMs - Date.now()));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tokens, refreshAccessToken]);
  return (
    <Context.Provider
      value={{
        status: restoring ? "loading" : status,
        identity,
        accessToken: tokens?.access_token ?? null,
        configured,
        login,
        refreshAccessToken,
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
