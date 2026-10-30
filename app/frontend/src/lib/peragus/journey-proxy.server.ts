const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const routes: Record<string, string[]> = {
  "registration/invite/check": ["POST"],
  "v1/me/pilot-invite/redeem": ["POST"],
  "v1/me/purchase-capabilities": ["GET"],
  "v1/me/customer": ["PATCH"],
  "v1/me/onboarding/individual": ["GET", "PUT"],
  "v1/me/onboarding/terms": ["GET", "POST"],
  "v1/me/onboarding/terms/accept": ["POST"],
  "v1/me/onboarding": ["GET"],
  "v1/me/onboarding/submit": ["POST"],
  "v1/me/onboarding/refresh": ["POST"],
  "v1/me/onboarding/verification": ["GET", "POST"],
  "v1/me/onboarding/verification/refresh": ["POST"],
  "v1/me/onboarding/screening": ["GET", "POST"],
  "v1/me/onboarding/screening/refresh": ["POST"],
  "v1/me/wallet": ["GET"],
  "v1/me/wallet/challenge": ["POST"],
  "v1/me/wallet/confirm": ["POST"],
  "v1/me/sandbox-pix": ["POST"],
};
export function journeyMethods(path: string) {
  if (new RegExp(`^v1/me/sandbox-pix/${UUID}$`, "i").test(path)) return ["GET"];
  if (new RegExp(`^v1/me/sandbox-pix/${UUID}/reconcile$`, "i").test(path)) return ["POST"];
  return routes[path] ?? [];
}
const fail = (status: number, code: string) =>
  Response.json({ error: { code } }, { status, headers: { "Cache-Control": "no-store" } });
export async function forwardJourney(request: Request, target: URL, path: string) {
  const methods = journeyMethods(path);
  if (!methods.length) return fail(404, "NOT_FOUND");
  if (!methods.includes(request.method)) return fail(405, "METHOD_NOT_ALLOWED");
  if (target.search) return fail(400, "VALIDATION_ERROR");
  if (
    target.username ||
    target.password ||
    (target.protocol !== "https:" &&
      !(
        target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
      ))
  )
    return fail(502, "BACKEND_UNAVAILABLE");
  const isPublic = path === "registration/invite/check",
    authorization = request.headers.get("authorization");
  if (
    !isPublic &&
    (!authorization ||
      authorization.length > 8192 ||
      !/^Bearer [A-Za-z0-9._-]+$/.test(authorization))
  )
    return fail(401, "AUTH_REQUIRED");
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, 20000);
  try {
    let body: string | undefined;
    if (request.method !== "GET" && request.body) {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
        return fail(400, "VALIDATION_ERROR");
      const reader = request.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          if (controller.signal.aborted) throw Error();
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 16384) {
            await reader.cancel();
            return fail(413, "BODY_TOO_LARGE");
          }
          chunks.push(part.value);
        }
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
      const all = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      body = new TextDecoder("utf-8", { fatal: true }).decode(all);
      try {
        const value = JSON.parse(body);
        if (!value || typeof value !== "object" || Array.isArray(value))
          return fail(400, "VALIDATION_ERROR");
      } catch {
        return fail(400, "VALIDATION_ERROR");
      }
    }
    const response = await fetch(target, {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(!isPublic ? { Authorization: authorization! } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!(response.headers.get("content-type") ?? "").includes("application/json"))
      return fail(502, "BACKEND_UNAVAILABLE");
    const content = await response.text();
    if (content.length > 262144) return fail(502, "BACKEND_UNAVAILABLE");
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Authorization",
    });
    const retry = response.headers.get("retry-after");
    if (retry) headers.set("Retry-After", retry);
    return new Response(content, { status: response.status, headers });
  } catch {
    return fail(502, "BACKEND_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
