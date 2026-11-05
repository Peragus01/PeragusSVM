import { forwardCustomerRead, isCustomerReadPath } from "@/lib/peragus/customer-proxy.server";
import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_BACKEND_URL = "http://127.0.0.1:3000";

type ProxyContext = {
  request: Request;
  params: { _splat: string };
};

function backendUrl() {
  const configured = process.env["PERAGUS_BACKEND_URL"] || DEFAULT_BACKEND_URL;
  const url = new URL(configured);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PERAGUS_BACKEND_URL must use HTTP or HTTPS.");
  }
  return url;
}

function targetUrl(request: Request, splat: string) {
  const target = backendUrl();
  const incoming = new URL(request.url);
  const prefix = target.pathname.replace(/\/$/, "");
  target.pathname = `${prefix}/${splat.replace(/^\/+/, "")}`;
  target.search = incoming.search;
  return target;
}

function isAllowedPath(splat: string) {
  return (
    isCustomerReadPath(splat) ||
    splat === "health" ||
    splat === "v1/settlements" ||
    splat.startsWith("v1/settlements/")
  );
}

/**
 * Same-origin bridge between the browser control room and the Peragus API.
 * It works in both the Vite development server and the built Nitro server,
 * while keeping the backend address and CORS concerns outside browser code.
 */
async function forward({ request, params }: ProxyContext) {
  if (!isAllowedPath(params._splat)) {
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }

  try {
    if (isCustomerReadPath(params._splat))
      return await forwardCustomerRead(request, targetUrl(request, params._splat));
    const headers = new Headers({ Accept: "application/json" });
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const response = await fetch(targetUrl(request, params._splat), {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: request.signal,
    });

    const responseHeaders = new Headers();
    const responseType = response.headers.get("content-type");
    const retryAfter = response.headers.get("retry-after");
    if (responseType) responseHeaders.set("Content-Type", responseType);
    if (retryAfter) responseHeaders.set("Retry-After", retryAfter);
    responseHeaders.set("Cache-Control", "no-store");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      { error: { code: "BACKEND_UNAVAILABLE" } },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: forward,
      POST: forward,
    },
  },
});
