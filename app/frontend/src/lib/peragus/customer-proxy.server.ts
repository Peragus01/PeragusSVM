const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const resultPath = new RegExp(`^v1/me/withdrawal-requests/${UUID}/result$`, "i");

export function isCustomerReadPath(path: string) {
  return path === "v1/me" || path === "v1/me/operations" || resultPath.test(path);
}

const headers = () => new Headers({ "Cache-Control": "no-store", Vary: "Authorization" });
const error = (status: number, code: string) =>
  Response.json({ error: { code } }, { status, headers: headers() });

/** Explicit GET-only bridge; the bearer is never persisted, logged or put in a URL. */
export async function forwardCustomerRead(request: Request, target: URL) {
  if (request.method !== "GET") {
    const response = error(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "GET");
    return response;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (
    target.username ||
    target.password ||
    (target.protocol !== "https:" && !(target.protocol === "http:" && local))
  )
    return error(502, "BACKEND_UNAVAILABLE");
  const authorization = request.headers.get("authorization");
  if (
    !authorization ||
    authorization.length > 8192 ||
    !/^Bearer [A-Za-z0-9._-]+$/.test(authorization)
  )
    return error(401, "AUTH_REQUIRED");

  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: authorization },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!(upstream.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
      return error(502, "BACKEND_UNAVAILABLE");
    // Read while the timeout remains active, before streaming the safe JSON response.
    const body = await upstream.text();
    const responseHeaders = headers();
    responseHeaders.set("Content-Type", "application/json");
    for (const name of ["retry-after", "www-authenticate"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return error(502, "BACKEND_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
