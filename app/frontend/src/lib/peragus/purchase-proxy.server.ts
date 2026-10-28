import { forwardCustomerRead } from "./customer-proxy.server";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const detail = new RegExp(`^v1/me/(quotes|purchase-intents)/${uuid}$`, "i");
export function purchaseMethods(path: string): string[] {
  if (["v1/me/quotes", "v1/me/purchase-intents"].includes(path)) return ["POST"];
  return detail.test(path) ? ["GET"] : [];
}
const headers = { "Cache-Control": "no-store", Vary: "Authorization" };
const error = (status: number, code: string) =>
  Response.json({ error: { code } }, { status, headers });
/** Only indicative quotes and record-only intentions; no Pix, simulations or withdrawals. */
export async function forwardPurchase(request: Request, target: URL, path: string) {
  const methods = purchaseMethods(path);
  if (!methods.length) return error(404, "NOT_FOUND");
  if (!methods.includes(request.method)) {
    const response = error(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", methods.join(", "));
    return response;
  }
  if (target.search) return error(400, "VALIDATION_ERROR");
  if (request.method === "GET") return forwardCustomerRead(request, target);
  const authorization = request.headers.get("authorization");
  if (
    !authorization ||
    authorization.length > 8192 ||
    !/^Bearer [A-Za-z0-9._-]+$/.test(authorization)
  )
    return error(401, "AUTH_REQUIRED");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (
    target.username ||
    target.password ||
    (target.protocol !== "https:" && !(target.protocol === "http:" && local))
  )
    return error(502, "BACKEND_UNAVAILABLE");
  if (
    target.search ||
    !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")
  )
    return error(400, "VALIDATION_ERROR");
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    // Bound the stream rather than trusting a caller-supplied Content-Length.
    const reader = request.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          if (controller.signal.aborted) throw Error("ABORTED");
          const part = await reader.read();
          if (controller.signal.aborted) throw Error("ABORTED");
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) {
            await reader.cancel();
            return error(413, "BODY_TOO_LARGE");
          }
          chunks.push(part.value);
        }
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    try {
      const parsed = JSON.parse(body);
      const keys =
        path === "v1/me/quotes" ? ["request_id", "source_amount_brl"] : ["request_id", "quote_id"];
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 2 ||
        !keys.every((k) => typeof parsed[k] === "string") ||
        !new RegExp(`^${uuid}$`, "i").test(parsed.request_id) ||
        (path === "v1/me/quotes"
          ? !/^(0|[1-9]\d{0,8})\.\d{2}$/.test(parsed.source_amount_brl)
          : !new RegExp(`^${uuid}$`, "i").test(parsed.quote_id))
      )
        return error(400, "VALIDATION_ERROR");
    } catch {
      return error(400, "VALIDATION_ERROR");
    }
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!(upstream.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
      return error(502, "BACKEND_UNAVAILABLE");
    const retryAfter = upstream.headers.get("retry-after");
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      },
    });
  } catch {
    return error(502, "BACKEND_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
