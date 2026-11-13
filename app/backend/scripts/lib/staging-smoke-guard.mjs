// Safety guard for scripts/staging-e2e-smoke.mjs. Pure functions with injectable fetch.
// The smoke may only run against test mode on solana:devnet. It never prints secrets.

export class SmokeGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SmokeGuardError";
    this.code = code;
  }
}

const LIVE_KEY_PREFIX = "ozav_sk_live_";

/** Environment-only checks (no network): production flag and live keys in any env var. */
export function assertLocalSafety(env) {
  if (env.PERAGUS_DEPLOYMENT_ENV === "production")
    throw new SmokeGuardError(
      "SMOKE_PRODUCTION_ENV",
      "Recusado: PERAGUS_DEPLOYMENT_ENV=production. O smoke so roda em staging (test + solana:devnet).",
    );
  for (const [name, value] of Object.entries(env))
    if (typeof value === "string" && value.trim().startsWith(LIVE_KEY_PREFIX))
      throw new SmokeGuardError(
        "SMOKE_LIVE_KEY_PRESENT",
        `Recusado: a variavel ${name} contem uma chave live da OZAV. Remova-a do ambiente do smoke.`,
      );
}

function normalizeBase(apiBase) {
  if (typeof apiBase !== "string" || !apiBase.trim())
    throw new SmokeGuardError("SMOKE_API_BASE_INVALID", "Recusado: STAGING_API_BASE_URL ausente.");
  let url;
  try {
    url = new URL(apiBase.trim());
  } catch {
    throw new SmokeGuardError("SMOKE_API_BASE_INVALID", "Recusado: STAGING_API_BASE_URL nao e uma URL valida.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && local)))
    throw new SmokeGuardError(
      "SMOKE_API_BASE_INVALID",
      "Recusado: STAGING_API_BASE_URL deve ser https (http so em localhost) e sem credenciais.",
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Network check: the target must report environment=test and network=solana:devnet. */
export async function assertTargetIsTest({ apiBase, customerToken, fetchImpl = fetch, timeoutMs = 15000 }) {
  const base = normalizeBase(apiBase);
  let status;
  let body;
  try {
    const response = await fetchImpl(`${base}/v1/me/purchase-capabilities`, {
      method: "GET",
      headers: { authorization: `Bearer ${customerToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    if (!response.ok) throw new Error("not ok");
    body = await response.json();
  } catch {
    throw new SmokeGuardError(
      "SMOKE_TARGET_UNVERIFIED",
      `Recusado: nao foi possivel confirmar o modo do alvo (GET /v1/me/purchase-capabilities${status ? `, HTTP ${status}` : ""}).`,
    );
  }
  const data = body?.data;
  if (data?.environment !== "test" || data?.network !== "solana:devnet")
    throw new SmokeGuardError(
      "SMOKE_TARGET_NOT_TEST",
      `Recusado: o alvo reporta environment=${String(data?.environment)} network=${String(data?.network)}; exigido test + solana:devnet.`,
    );
}

/** Full guard: local checks first, then the single capability request. */
export async function assertStagingSafe({ env, apiBase, customerToken, fetchImpl = fetch, timeoutMs }) {
  assertLocalSafety(env);
  normalizeBase(apiBase);
  if (typeof customerToken !== "string" || !customerToken.trim())
    throw new SmokeGuardError("SMOKE_CUSTOMER_TOKEN_MISSING", "Recusado: STAGING_CUSTOMER_TOKEN ausente.");
  await assertTargetIsTest({ apiBase, customerToken, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
}

export { normalizeBase };
