import { createContext, useContext } from "react";
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
export type AuthTokens = { access_token: string; refresh_token: string; expires_at: number };
export type OperatorMfaEnrollment = {
  factorId: string;
  qrCode: string;
  secret: string | null;
};
export type SessionState = "unauthenticated" | "loading" | "authenticated";
export type SessionContextValue = {
  status: SessionState;
  identity: CustomerIdentity | null;
  accessToken: string | null;
  configured: boolean;
  login: (email: string, password: string) => Promise<void>;
  enrollOperatorMfa: () => Promise<OperatorMfaEnrollment>;
  verifyOperatorMfaEnrollment: (factorId: string, code: string) => Promise<void>;
  /**
   * Challenge + verify of the verified TOTP factor; resolves with the new access token,
   * whose `amr` totp timestamp is the time of this verification (fresh MFA).
   */
  verifyOperatorMfa: (code: string) => Promise<string>;
  logout: () => void;
  reloadIdentity: (signal?: AbortSignal) => Promise<void>;
};
export const Context = createContext<SessionContextValue | null>(null);
export function useCustomerSession() {
  const value = useContext(Context);
  if (!value) throw new Error("CustomerSessionProvider is required");
  return value;
}
