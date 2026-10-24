import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Frontend-only, memory-only Supabase Auth bridge. The backend remains authoritative:
 * never infer KYC, privileges or account ownership from the browser session.
 */
export interface CustomerProfile {
  id: string;
  type: "pf" | "pj";
  display_name: string;
  verification_status:
    "draft" | "submitted" | "in_review" | "action_required" | "approved" | "rejected";
  suspended: boolean;
  operations_enabled: boolean;
}
export interface CustomerIdentity {
  user: { id: string; email: string };
  customer: CustomerProfile | null;
}
type AuthTokens = { access_token: string; refresh_token: string; expires_at: number };
type SessionState = "unauthenticated" | "loading" | "authenticated";
type SessionContextValue = {
  status: SessionState;
  identity: CustomerIdentity | null;
  accessToken: string | null;
  configured: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  reloadIdentity: (signal?: AbortSignal) => Promise<void>;
};
const Context = createContext<SessionContextValue | null>(null);
const env = import.meta.env as Record<string, string | undefined>;
const rawUrl = env["VITE_SUPABASE_URL"] ?? "";
const anonKey = env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? "";
const origin = (() => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" &&
      /^[a-z0-9]+\.supabase\.co$/.test(url.hostname) &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
})();
const configured = Boolean(origin && anonKey && !anonKey.startsWith("sb_secret_"));

export class CustomerSessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
async function supabaseAuth(
  path: string,
  body: object,
  method: "POST" | "PUT" = "POST",
  token?: string,
) {
  if (!origin || !configured)
    throw new CustomerSessionError(
      "AUTH_NOT_CONFIGURED",
      "O login ainda não foi configurado neste ambiente.",
    );
  let response: Response;
  try {
    response = await fetch(origin + "/auth/v1/" + path, {
      method,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CustomerSessionError(
      "AUTH_UNAVAILABLE",
      "Serviço de autenticação temporariamente indisponível.",
    );
  }
  if (!response.ok) {
    throw new CustomerSessionError(
      "AUTH_REJECTED",
      response.status === 400 || response.status === 401
        ? "Não foi possível autenticar. Verifique suas credenciais e o e-mail confirmado."
        : "Autenticação indisponível. Tente novamente mais tarde.",
    );
  }
  if (response.status === 204) return {};
  return (await response.json()) as Record<string, unknown>;
}
function parseTokens(value: Record<string, unknown>): AuthTokens {
  if (
    typeof value["access_token"] !== "string" ||
    typeof value["refresh_token"] !== "string" ||
    typeof value["expires_in"] !== "number" ||
    value["expires_in"] <= 0
  ) {
    throw new CustomerSessionError("INVALID_AUTH_RESPONSE", "Sessão de autenticação inválida.");
  }
  return {
    access_token: value["access_token"],
    refresh_token: value["refresh_token"],
    expires_at: Date.now() + value["expires_in"] * 1000,
  };
}
async function fetchIdentity(token: string, signal?: AbortSignal): Promise<CustomerIdentity> {
  let response: Response;
  try {
    response = await fetch("/api/v1/me", {
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
  } catch {
    if (signal?.aborted) throw new CustomerSessionError("ABORTED", "Consulta cancelada.");
    throw new CustomerSessionError("BACKEND_UNAVAILABLE", "Não foi possível consultar sua conta.");
  }
  if (!response.ok) {
    throw new CustomerSessionError(
      "IDENTITY_" + response.status,
      response.status === 401
        ? "Sessão expirada. Entre novamente."
        : response.status === 403
          ? "Confirme seu e-mail para acessar a conta."
          : "Não foi possível confirmar sua conta.",
    );
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("data" in body))
    throw new CustomerSessionError("INVALID_RESPONSE", "Resposta de identidade inválida.");
  const data = (body as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("user" in data))
    throw new CustomerSessionError("INVALID_RESPONSE", "Resposta de identidade inválida.");
  const item = data as CustomerIdentity;
  if (
    !item.user ||
    typeof item.user.id !== "string" ||
    typeof item.user.email !== "string" ||
    (item.customer != null &&
      (typeof item.customer.id !== "string" ||
        !["draft", "submitted", "in_review", "action_required", "approved", "rejected"].includes(
          item.customer.verification_status,
        )))
  ) {
    throw new CustomerSessionError("INVALID_RESPONSE", "Resposta de identidade inválida.");
  }
  return item;
}
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
        reloadIdentity,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useCustomerSession() {
  const value = useContext(Context);
  if (!value) throw new Error("CustomerSessionProvider is required");
  return value;
}
export async function requestPasswordRecovery(email: string) {
  if (typeof window === "undefined")
    throw new CustomerSessionError(
      "BROWSER_REQUIRED",
      "Recuperação disponível apenas no navegador.",
    );
  const redirect = new URL("/recuperar-senha", window.location.origin).toString();
  await supabaseAuth("recover?redirect_to=" + encodeURIComponent(redirect), { email });
}
export async function completePasswordRecovery(accessToken: string, password: string) {
  await supabaseAuth("user", { password }, "PUT", accessToken);
}
