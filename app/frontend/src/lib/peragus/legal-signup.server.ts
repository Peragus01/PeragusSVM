import { validLegalAcknowledgements } from "./legal-acknowledgement";

const fail = (status: number, code: string) =>
  Response.json({ error: { code } }, { status, headers: { "Cache-Control": "no-store" } });

function backendOrigin(raw: string) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Invalid backend URL");
  }
  return url.origin + url.pathname.replace(/\/$/, "");
}

function authOrigin(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Invalid Supabase URL");
  }
  return url.origin;
}

export async function handleLegalSignup(
  request: Request,
  options: { fetcher?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const env = options.env ?? process.env;
  if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED");
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return fail(415, "VALIDATION_ERROR");
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return fail(403, "ORIGIN_REFUSED");
  }

  let payload: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 8192) return fail(413, "BODY_TOO_LARGE");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail(400, "VALIDATION_ERROR");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return fail(400, "VALIDATION_ERROR");
  }

  if (!validLegalAcknowledgements(payload["legal"])) {
    const legal = payload["legal"] as Record<string, unknown> | undefined;
    if (legal && legal["termsAccepted"] === true && legal["privacyAcknowledged"] === true) {
      return fail(409, "DOCUMENT_VERSION_MISMATCH");
    }
    return fail(422, "LEGAL_ACKNOWLEDGEMENT_REQUIRED");
  }

  const email = typeof payload["email"] === "string" ? payload["email"].trim() : "";
  const password = payload["password"];
  const inviteCode = payload["inviteCode"];
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256 ||
    typeof inviteCode !== "string" ||
    !/^pginv_[A-Za-z0-9_-]{43}$/.test(inviteCode)
  ) {
    return fail(400, "VALIDATION_ERROR");
  }

  let backend: string;
  let supabase: string;
  const key = env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  try {
    backend = backendOrigin(env["PERAGUS_BACKEND_URL"] || "http://127.0.0.1:3000");
    supabase = authOrigin(env["VITE_SUPABASE_URL"] || "");
    if (!key || key.startsWith("sb_secret_")) throw Error("Invalid public key");
  } catch {
    return fail(503, "SIGNUP_NOT_CONFIGURED");
  }

  try {
    // Recheck the invitation on the server before calling Supabase Auth.
    const invitation = await fetcher(backend + "/registration/invite/check", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode, email }),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
    });
    if (!invitation.ok) {
      return fail(invitation.status === 429 ? 429 : 409, "PILOT_INVITE_NOT_AVAILABLE");
    }
    const check: unknown = await invitation.json();
    const checked = (check as { data?: { valid?: unknown; environment?: unknown } })?.data;
    if (checked?.valid !== true || checked?.environment !== "test") {
      return fail(409, "PILOT_INVITE_NOT_AVAILABLE");
    }

    const signup = await fetcher(supabase + "/auth/v1/signup", {
      method: "POST",
      headers: { apikey: key, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
    });
    if (!signup.ok) return fail(signup.status === 429 ? 429 : 400, "AUTH_REJECTED");
    return Response.json(
      { data: { submitted: true } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return fail(503, "SIGNUP_UNAVAILABLE");
  }
}
