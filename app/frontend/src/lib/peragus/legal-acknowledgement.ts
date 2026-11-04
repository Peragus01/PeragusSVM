/** These versions identify legal drafts in staging. Legal review required before production. */
export const LEGAL_TERMS_VERSION = "draft-0.9-2026-11-03";
export const LEGAL_PRIVACY_VERSION = "draft-0.9-2026-11-03";

export const LEGAL_URLS = {
  terms: "/legal/termos-de-uso.html",
  privacy: "/legal/politica-de-privacidade.html",
  refund: "/legal/politica-de-reembolso.html",
} as const;

export interface LegalAcknowledgements {
  termsAccepted: boolean;
  privacyAcknowledged: boolean;
  termsVersion: string;
  privacyVersion: string;
}

export function canCreateAccount(termsAccepted: boolean, privacyAcknowledged: boolean) {
  return termsAccepted === true && privacyAcknowledged === true;
}

export function validLegalAcknowledgements(value: unknown): value is LegalAcknowledgements {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  return (
    a["termsAccepted"] === true &&
    a["privacyAcknowledged"] === true &&
    a["termsVersion"] === LEGAL_TERMS_VERSION &&
    a["privacyVersion"] === LEGAL_PRIVACY_VERSION
  );
}
