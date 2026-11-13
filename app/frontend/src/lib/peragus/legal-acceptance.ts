import { LEGAL_DOCUMENT_KEYS, type LegalDocumentKey } from "./legal-acknowledgement";

export interface RequiredLegalDocument {
  document: LegalDocumentKey;
  version: string;
}
export interface LegalStatus {
  required: RequiredLegalDocument[];
  missing: RequiredLegalDocument[];
}

export class LegalAcceptanceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Fired by any customer request the backend refused with LEGAL_ACCEPTANCE_REQUIRED. */
export const LEGAL_REQUIRED_EVENT = "peragus:legal-acceptance-required";
export function notifyLegalRequired(code: unknown) {
  if (code === "LEGAL_ACCEPTANCE_REQUIRED" && typeof window !== "undefined")
    window.dispatchEvent(new Event(LEGAL_REQUIRED_EVENT));
}

const isDocument = (value: unknown): value is LegalDocumentKey =>
  typeof value === "string" && (LEGAL_DOCUMENT_KEYS as readonly string[]).includes(value);
function parseList(value: unknown): RequiredLegalDocument[] {
  if (!Array.isArray(value)) throw new LegalAcceptanceError("INVALID_RESPONSE");
  return value.map((item: unknown) => {
    const row = item as Record<string, unknown> | null;
    if (!row || !isDocument(row["document"]) || typeof row["version"] !== "string")
      throw new LegalAcceptanceError("INVALID_RESPONSE");
    return { document: row["document"], version: row["version"] };
  });
}

async function call(token: string, body?: object, signal?: AbortSignal): Promise<LegalStatus> {
  if (!token || !/^[A-Za-z0-9._-]+$/.test(token)) throw new LegalAcceptanceError("AUTH_REQUIRED");
  let response: Response;
  try {
    response = await fetch("/api/v1/me/legal-acceptances", {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
  } catch {
    throw new LegalAcceptanceError("OUTCOME_UNKNOWN");
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new LegalAcceptanceError("LEGAL_ACCEPTANCE_UNAVAILABLE");
  }
  const root = json as { data?: Record<string, unknown>; error?: { code?: unknown } } | null;
  if (!response.ok) {
    const code = root?.error?.code;
    throw new LegalAcceptanceError(
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
        ? code
        : "LEGAL_ACCEPTANCE_UNAVAILABLE",
    );
  }
  if (!root?.data) throw new LegalAcceptanceError("INVALID_RESPONSE");
  return { required: parseList(root.data["required"]), missing: parseList(root.data["missing"]) };
}

export const getLegalStatus = (token: string, signal?: AbortSignal) =>
  call(token, undefined, signal);
/** Sends the versions the server asked for; the server keeps the hashes. */
export const acceptLegalDocuments = (token: string, documents: RequiredLegalDocument[]) =>
  call(token, { documents: documents.map(({ document, version }) => ({ document, version })) });

export function legalMessage(code: string) {
  return (
    (
      {
        LEGAL_VERSION_MISMATCH:
          "Os documentos foram atualizados. Recarregue a página para ler a versão vigente antes de aceitar.",
        LEGAL_ACCEPTANCE_UNAVAILABLE:
          "O registro do aceite está indisponível. Nada foi registrado; tente novamente.",
        OUTCOME_UNKNOWN:
          "Não foi possível confirmar o resultado. Atualize a página para ver o estado do seu aceite.",
        AUTH_REQUIRED: "Sessão expirada. Entre novamente.",
      } as Record<string, string>
    )[code] ?? `Não foi possível registrar o aceite (${code}). Tente novamente.`
  );
}
