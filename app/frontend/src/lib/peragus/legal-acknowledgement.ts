/**
 * Public legal documents. Required versions are NOT hard-coded here: the backend decides
 * them (GET /v1/me/legal-acceptances) and is the only gate that matters.
 */
export const LEGAL_URLS = {
  terms: "/legal/termos-de-uso.html",
  privacy: "/legal/politica-de-privacidade.html",
  refund: "/legal/politica-de-reembolso.html",
} as const;

export type LegalDocumentKey = keyof typeof LEGAL_URLS;
export const LEGAL_DOCUMENT_KEYS = ["terms", "privacy", "refund"] as const;
export const LEGAL_LABELS: Record<LegalDocumentKey, string> = {
  terms: "Termos de Uso",
  privacy: "Política de Privacidade",
  refund: "Política de Reembolso",
};

export function canCreateAccount(checked: Record<LegalDocumentKey, boolean>) {
  return LEGAL_DOCUMENT_KEYS.every((key) => checked[key] === true);
}
