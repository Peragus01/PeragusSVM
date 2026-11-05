import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AuthenticationError, type AuthenticatedUser } from "./customer-access.js";

const userSchema = z.object({
  id: z.string().uuid(), email: z.string().email(),
  email_confirmed_at: z.string().min(1),
  is_anonymous: z.literal(false).optional(),
});

// Supabase verifies tokens against this configured project; never trust a decoded client JWT.
export function createSupabaseAuthenticator(url: string, publishableKey: string, fetcher: typeof fetch = fetch) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port
    || endpoint.pathname !== "/") throw new Error("SUPABASE_URL must be a hosted project HTTPS origin");
  if (!publishableKey.trim()) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
  const client = createClient(endpoint.origin, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(5000), redirect: "error" }) },
  });
  return async (token: string): Promise<AuthenticatedUser> => {
    let result;
    try { result = await client.auth.getUser(token); }
    catch { throw new AuthenticationError("AUTH_UNAVAILABLE"); }
    if (result.error) {
      const status = result.error.status;
      throw new AuthenticationError(status === 401 || status === 403 ? "INVALID_TOKEN" : "AUTH_UNAVAILABLE");
    }
    const user = result.data.user;
    if (user && !user.email_confirmed_at) throw new AuthenticationError("EMAIL_NOT_CONFIRMED");
    const parsed = userSchema.safeParse(user);
    if (!parsed.success) throw new AuthenticationError("INVALID_TOKEN");
    // Decode assurance ONLY after getUser accepted this exact bearer token at the
    // pinned Auth server. Never derive identity or role from an unverified JWT.
    let assuranceLevel: "aal2" | undefined;
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
        if (claims.sub === parsed.data.id && claims.iss === `${endpoint.origin}/auth/v1`
          && claims.aud === "authenticated" && claims.aal === "aal2"
          && Number.isInteger(claims.exp) && claims.exp > Date.now()/1000) assuranceLevel = "aal2";
      }
    } catch { /* Unknown assurance is never privileged. */ }
    return { id: parsed.data.id, email: parsed.data.email, ...(assuranceLevel ? {assuranceLevel} : {}) };
  };
}
