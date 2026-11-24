const maxBytes = 4096;
const headers = { "Cache-Control": "no-store" };

export async function forwardCommercialLead(request: Request, target: URL) {
  if (request.method !== "POST") {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED" } },
      {
        status: 405,
        headers: { ...headers, Allow: "POST" },
      },
    );
  }
  const origin = request.headers.get("origin");
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin && origin !== new URL(request.url).origin)
  ) {
    return Response.json({ error: { code: "ORIGIN_NOT_ALLOWED" } }, { status: 403, headers });
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return Response.json({ error: { code: "JSON_REQUIRED" } }, { status: 415, headers });
  }

  const body = new Uint8Array(maxBytes);
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.length > maxBytes) {
          await reader.cancel();
          return Response.json({ error: { code: "BODY_TOO_LARGE" } }, { status: 413, headers });
        }
        body.set(value, length);
        length += value.length;
      }
    } finally {
      reader.releaseLock();
    }
  }

  target.search = "";
  const result = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body.subarray(0, length),
    redirect: "error",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]),
  });
  const responseHeaders = new Headers(headers);
  for (const name of ["content-type", "retry-after"]) {
    const value = result.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(result.body, { status: result.status, headers: responseHeaders });
}
