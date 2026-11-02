export const DOCUMENT_LIMIT = 4 * 1024 * 1024;
export type DocumentType = "identity_document" | "selfie" | "proof_of_address";
export type DocumentSide = "front" | "back" | "single" | "none";
export type DocumentState =
  "declaring" | "uploading" | "pending_confirmation" | "received" | "rejected" | "uncertain";
export interface DocumentRecord {
  id: string;
  doc_type: DocumentType;
  side: DocumentSide;
  state: DocumentState;
  environment: "test";
  identity_verified: false;
  operations_enabled: false;
}
export interface DocumentRequirements {
  required_documents: null | { doc_type: string; supported_for_upload: boolean }[];
}
export const documentLabels: Record<DocumentType, string> = {
  identity_document: "Documento de identidade",
  selfie: "Selfie",
  proof_of_address: "Comprovante de endereço",
};
export const documentStates: Record<DocumentState, string> = {
  declaring: "Envio em acompanhamento",
  uploading: "Envio em acompanhamento",
  pending_confirmation: "Recebimento em confirmação",
  received: "Arquivo recebido — análise pendente",
  rejected: "Arquivo recusado",
  uncertain: "Resultado do envio não confirmado",
};
export class DocumentClientError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseDocument(x: unknown): DocumentRecord {
  if (
    !record(x) ||
    typeof x["id"] !== "string" ||
    !uuid.test(x["id"]) ||
    !Object.hasOwn(documentLabels, String(x["doc_type"])) ||
    !Object.hasOwn(documentStates, String(x["state"])) ||
    !(x["doc_type"] === "identity_document"
      ? ["front", "back", "single"].includes(String(x["side"]))
      : x["side"] === "none") ||
    x["environment"] !== "test" ||
    x["identity_verified"] !== false ||
    x["operations_enabled"] !== false
  )
    throw new DocumentClientError("DOCUMENT_RESPONSE_INVALID");
  return {
    id: x["id"],
    doc_type: x["doc_type"] as DocumentType,
    side: x["side"] as DocumentSide,
    state: x["state"] as DocumentState,
    environment: "test",
    identity_verified: false,
    operations_enabled: false,
  };
}
async function request(
  token: string,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 35000);
  try {
    const response = await fetch("/api/v1/me/onboarding/documents" + path, {
      method: "GET",
      ...init,
      headers: { Accept: "application/json", Authorization: "Bearer " + token, ...init.headers },
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    const payload: unknown = await response.json();
    if (!response.ok)
      throw new DocumentClientError(
        record(payload) && record(payload["error"]) && typeof payload["error"]["code"] === "string"
          ? payload["error"]["code"]
          : "DOCUMENT_UNAVAILABLE",
      );
    if (!record(payload) || !("data" in payload))
      throw new DocumentClientError("DOCUMENT_RESPONSE_INVALID");
    return payload["data"];
  } catch (e) {
    if (e instanceof DocumentClientError) throw e;
    throw new DocumentClientError("DOCUMENT_OUTCOME_UNKNOWN");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export async function listDocuments(token: string, signal?: AbortSignal) {
  const value = await request(token, "", {}, signal);
  if (!Array.isArray(value) || value.length > 50)
    throw new DocumentClientError("DOCUMENT_RESPONSE_INVALID");
  return value.map(parseDocument);
}
export async function documentRequirements(
  token: string,
  signal?: AbortSignal,
): Promise<DocumentRequirements> {
  const value = await request(token, "/requirements", {}, signal);
  if (
    !record(value) ||
    value["environment"] !== "test" ||
    value["identity_verified"] !== false ||
    value["operations_enabled"] !== false
  )
    throw new DocumentClientError("DOCUMENT_RESPONSE_INVALID");
  const required = value["required_documents"];
  if (required === null) return { required_documents: null };
  if (
    !Array.isArray(required) ||
    required.length > 18 ||
    required.some(
      (x) =>
        !record(x) ||
        typeof x["doc_type"] !== "string" ||
        !/^[a-z_]{1,50}$/.test(x["doc_type"]) ||
        typeof x["supported_for_upload"] !== "boolean" ||
        x["supported_for_upload"] !== Object.hasOwn(documentLabels, x["doc_type"]),
    )
  )
    throw new DocumentClientError("DOCUMENT_RESPONSE_INVALID");
  return {
    required_documents: required.map((x) => ({
      doc_type: x["doc_type"] as string,
      supported_for_upload: x["supported_for_upload"] as boolean,
    })),
  };
}
export function validateDocumentFile(file: File, type: DocumentType) {
  if (!file.size || file.size > DOCUMENT_LIMIT) return "Selecione um arquivo de até 4 MiB.";
  if (
    !(
      type === "proof_of_address"
        ? ["image/jpeg", "image/png", "application/pdf"]
        : ["image/jpeg", "image/png"]
    ).includes(file.type)
  )
    return "Formato inválido. Use JPEG ou PNG; PDF somente para comprovante de endereço.";
  return null;
}
export async function sendDocument(
  token: string,
  file: File,
  type: DocumentType,
  side: DocumentSide,
  key: string,
  signal?: AbortSignal,
) {
  if (validateDocumentFile(file, type) || !uuid.test(key))
    throw new DocumentClientError("DOCUMENT_VALIDATION_ERROR");
  return parseDocument(
    await request(
      token,
      "",
      {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "X-Document-Type": type,
          "X-Document-Side": side,
          "Idempotency-Key": key,
        },
        body: file,
      },
      signal,
    ),
  );
}
export async function refreshDocument(token: string, id: string, signal?: AbortSignal) {
  if (!uuid.test(id)) throw new DocumentClientError("DOCUMENT_VALIDATION_ERROR");
  return parseDocument(await request(token, "/" + id + "/refresh", { method: "POST" }, signal));
}
export function documentMessage(e: unknown) {
  const code = e instanceof DocumentClientError ? e.code : "";
  if (code === "CUSTOMER_DOCUMENTS_DISABLED")
    return "O envio de arquivos ainda não está disponível neste ambiente.";
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID" || code === "EMAIL_NOT_CONFIRMED")
    return "Entre novamente para consultar seus documentos.";
  if (code === "DOCUMENT_VALIDATION_ERROR" || code === "DOCUMENT_TOO_LARGE")
    return "Confira o formato e o tamanho do arquivo (máximo 4 MiB).";
  return "Não foi possível confirmar o resultado. Atualize os envios antes de tentar outra ação. Se o resultado continuar indisponível, entre em contato com o suporte.";
}
