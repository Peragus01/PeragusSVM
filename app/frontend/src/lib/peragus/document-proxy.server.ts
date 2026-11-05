const root = "v1/me/onboarding/documents";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const DOCUMENT_PROXY_LIMIT = 4 * 1024 * 1024;
export function documentMethods(path: string): string[] {
  if (path === root) return ["GET", "POST"];
  if (path === root + "/requirements" || new RegExp(`^${root}/${id}$`, "i").test(path))
    return ["GET"];
  if (new RegExp(`^${root}/${id}/refresh$`, "i").test(path)) return ["POST"];
  return [];
}
const fail = (status: number, code: string) =>
  Response.json(
    { error: { code } },
    { status, headers: { "Cache-Control": "no-store", Vary: "Authorization" } },
  );
async function bounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw Error("ABORTED");
      const part = await reader.read();
      if (signal.aborted) throw Error("ABORTED");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Error("LIMIT");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
/** Private binary bridge. Never forwards cookies, filenames, URLs or arbitrary caller headers. */
export async function forwardDocument(request: Request, target: URL, path: string) {
  const methods = documentMethods(path);
  if (!methods.length) return fail(404, "NOT_FOUND");
  if (!methods.includes(request.method)) return fail(405, "METHOD_NOT_ALLOWED");
  if (target.search || target.hash) return fail(400, "DOCUMENT_VALIDATION_ERROR");
  if (
    target.username ||
    target.password ||
    (target.protocol !== "https:" &&
      !(
        target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
      ))
  )
    return fail(502, "BACKEND_UNAVAILABLE");
  const auth = request.headers.get("authorization");
  if (!auth || auth.length > 8192 || !/^Bearer [A-Za-z0-9._-]+$/.test(auth))
    return fail(401, "AUTH_REQUIRED");
  const upload = path === root && request.method === "POST";
  const headers = new Headers({ Accept: "application/json", Authorization: auth });
  if (upload) {
    const mime = request.headers.get("content-type") ?? "";
    const type = request.headers.get("x-document-type") ?? "";
    const side = request.headers.get("x-document-side") ?? "";
    const key = request.headers.get("idempotency-key") ?? "";
    if (
      !["image/jpeg", "image/png", "application/pdf"].includes(mime) ||
      !["identity_document", "selfie", "proof_of_address", "bank_statement"].includes(type) ||
      !(type === "identity_document"
        ? ["front", "back", "single"].includes(side)
        : side === "none") ||
      !new RegExp(`^${id}$`, "i").test(key) ||
      (mime === "application/pdf" && !["proof_of_address", "bank_statement"].includes(type))
    )
      return fail(400, "DOCUMENT_VALIDATION_ERROR");
    for (const name of ["content-type", "x-document-type", "x-document-side", "idempotency-key"])
      headers.set(name, request.headers.get(name)!);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, 30000);
  let bytes: Uint8Array | undefined;
  try {
    try {
      bytes = await bounded(request.body, upload ? DOCUMENT_PROXY_LIMIT : 0, controller.signal);
    } catch (e) {
      if (e instanceof Error && e.message === "LIMIT")
        return fail(
          upload ? 413 : 400,
          upload ? "DOCUMENT_TOO_LARGE" : "DOCUMENT_VALIDATION_ERROR",
        );
      throw e;
    }
    if (upload && !bytes.length) return fail(400, "DOCUMENT_VALIDATION_ERROR");
    const response = await fetch(target, {
      method: request.method,
      headers,
      ...(upload ? { body: bytes as BodyInit } : {}),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!(response.headers.get("content-type") ?? "").includes("application/json"))
      return fail(502, "BACKEND_UNAVAILABLE");
    const content = await bounded(response.body, 262144, controller.signal);
    JSON.parse(new TextDecoder().decode(content));
    return new Response(content as BodyInit, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Vary: "Authorization",
      },
    });
  } catch {
    return fail(502, "DOCUMENT_OUTCOME_UNKNOWN");
  } finally {
    bytes?.fill(0);
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
