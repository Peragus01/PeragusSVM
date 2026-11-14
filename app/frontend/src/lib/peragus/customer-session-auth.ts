import type { AuthTokens, CustomerIdentity } from "./customer-session-context";
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
export const configured = Boolean(origin && anonKey && !anonKey.startsWith("sb_secret_"));

export class CustomerSessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function supabaseAuth(
  path: string,
  body: object,
  method: "POST" | "PUT" | "GET" | "DELETE" = "POST",
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
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(method === "POST" || method === "PUT" ? { body: JSON.stringify(body) } : {}),
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
export async function signUpCustomer(email: string, password: string) {
  await supabaseAuth("signup", { email, password });
}
export function parseTokens(value: Record<string, unknown>): AuthTokens {
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
export async function refreshSession(refreshToken: string): Promise<AuthTokens> {
  return parseTokens(
    await supabaseAuth("token?grant_type=refresh_token", { refresh_token: refreshToken }),
  );
}
export async function fetchIdentity(
  token: string,
  signal?: AbortSignal,
): Promise<CustomerIdentity> {
  let response: Response;
  try {
    response = await fetch("/api/v1/me", {
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "same-origin",
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
/**
 * Asks the backend whether this account (AAL1 is enough) is an allowlisted operator.
 * Fails closed: any error, non-2xx answer or unexpected body means "not an operator".
 */
export async function fetchOperatorStatus(token: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/admin/operator-status", {
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { data?: { operator?: unknown } } | null;
    return body?.data?.operator === true;
  } catch {
    return false;
  }
}
