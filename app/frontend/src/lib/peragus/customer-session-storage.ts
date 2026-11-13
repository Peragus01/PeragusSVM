import type { AuthTokens } from "./customer-session-context";

/** Tab-scoped (sessionStorage) so closing the tab/browser ends the session. Never localStorage. */
export const SESSION_STORAGE_KEY = "peragus.session";

export type StoredSession = AuthTokens & { user: { id: string; email: string } };

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function clearStoredSession() {
  try {
    store()?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage may be blocked; the in-memory session still works.
  }
}

export function saveStoredSession(session: StoredSession) {
  try {
    // Only what is needed to restore. Never MFA codes or other fields.
    store()?.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user: { id: session.user.id, email: session.user.email },
      }),
    );
  } catch {
    // Quota/blocked storage: degrade to memory-only.
  }
}

/** Returns a fully valid stored session or null; corrupt data is discarded. */
export function loadStoredSession(): StoredSession | null {
  const area = store();
  if (!area) return null;
  try {
    const raw = area.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      const user = v["user"] as Record<string, unknown> | null | undefined;
      if (
        typeof v["access_token"] === "string" &&
        v["access_token"] &&
        typeof v["refresh_token"] === "string" &&
        v["refresh_token"] &&
        typeof v["expires_at"] === "number" &&
        Number.isFinite(v["expires_at"]) &&
        user &&
        typeof user === "object" &&
        typeof user["id"] === "string" &&
        typeof user["email"] === "string"
      )
        return {
          access_token: v["access_token"],
          refresh_token: v["refresh_token"],
          expires_at: v["expires_at"],
          user: { id: user["id"], email: user["email"] },
        };
    }
  } catch {
    // fall through to discard
  }
  clearStoredSession();
  return null;
}
