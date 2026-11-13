// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentMethods } from "@/lib/peragus/document-proxy.server";
import { journeyMethods } from "@/lib/peragus/journey-proxy.server";
import { forwardPurchase, purchaseMethods } from "@/lib/peragus/purchase-proxy.server";
import { refundMethods } from "@/lib/peragus/refund-proxy.server";
import { operatorMethods } from "@/lib/peragus/operator-proxy.server";
import { isCustomerReadPath } from "@/lib/peragus/customer-proxy.server";

/**
 * Every backend path the browser code calls, with the methods it uses and the one
 * proxy allowlist meant to carry it. The scan below fails when a new call appears
 * that is not listed here, so a frontend call can never ship without its proxy route.
 */
const ID = "d3f9d95d-5719-48c8-9c30-a27fa0b27219";
type Proxy = "document" | "journey" | "purchase" | "refund" | "operator" | "customerRead";
const CALLS: { path: string; methods: string[]; proxy: Proxy }[] = [
  { path: "v1/me", methods: ["GET"], proxy: "customerRead" },
  { path: "v1/me/onboarding/status", methods: ["GET"], proxy: "customerRead" },
  { path: "v1/me/operations", methods: ["GET"], proxy: "customerRead" },
  { path: `v1/me/withdrawal-requests/${ID}/result`, methods: ["GET"], proxy: "customerRead" },
  { path: "v1/me/onboarding/documents", methods: ["GET", "POST"], proxy: "document" },
  { path: "v1/me/onboarding/documents/requirements", methods: ["GET"], proxy: "document" },
  { path: `v1/me/onboarding/documents/${ID}/refresh`, methods: ["POST"], proxy: "document" },
  { path: "registration/invite/check", methods: ["POST"], proxy: "journey" },
  { path: "v1/me/pilot-invite/redeem", methods: ["POST"], proxy: "journey" },
  { path: "v1/admin/pilot-invites", methods: ["GET", "POST"], proxy: "journey" },
  { path: `v1/admin/pilot-invites/${ID}/revoke`, methods: ["POST"], proxy: "journey" },
  { path: "v1/me/legal-acceptances", methods: ["GET", "POST"], proxy: "journey" },
  { path: "v1/me/purchase-capabilities", methods: ["GET"], proxy: "journey" },
  { path: "v1/me/customer", methods: ["PATCH"], proxy: "journey" },
  { path: "v1/me/onboarding", methods: ["GET"], proxy: "journey" },
  { path: "v1/me/onboarding/individual", methods: ["GET", "PUT"], proxy: "journey" },
  { path: "v1/me/onboarding/terms", methods: ["GET", "POST"], proxy: "journey" },
  { path: "v1/me/onboarding/terms/accept", methods: ["POST"], proxy: "journey" },
  { path: "v1/me/onboarding/submit", methods: ["POST"], proxy: "journey" },
  { path: "v1/me/onboarding/refresh", methods: ["POST"], proxy: "journey" },
  { path: "v1/me/onboarding/verification", methods: ["GET", "POST"], proxy: "journey" },
  { path: "v1/me/onboarding/verification/refresh", methods: ["POST"], proxy: "journey" },
  { path: "v1/me/onboarding/screening", methods: ["GET", "POST"], proxy: "journey" },
  { path: "v1/me/onboarding/screening/refresh", methods: ["POST"], proxy: "journey" },
  { path: "v1/me/wallet/challenge", methods: ["POST"], proxy: "journey" },
  { path: "v1/me/wallet/confirm", methods: ["POST"], proxy: "journey" },
  { path: "v1/me/sandbox-pix", methods: ["POST"], proxy: "journey" },
  { path: `v1/me/sandbox-pix/${ID}`, methods: ["GET"], proxy: "journey" },
  { path: `v1/me/sandbox-pix/${ID}/reconcile`, methods: ["POST"], proxy: "journey" },
  { path: "v1/me/quotes", methods: ["POST"], proxy: "purchase" },
  { path: `v1/me/quotes/${ID}`, methods: ["GET"], proxy: "purchase" },
  { path: "v1/me/purchase-intents", methods: ["POST"], proxy: "purchase" },
  { path: `v1/me/purchase-intents/${ID}`, methods: ["GET"], proxy: "purchase" },
  { path: `v1/me/purchase-intents/${ID}/cancel`, methods: ["POST"], proxy: "purchase" },
  { path: `v1/me/operations/${ID}/refund-request`, methods: ["GET", "POST"], proxy: "refund" },
  { path: "v1/admin/refund-requests", methods: ["GET"], proxy: "refund" },
  { path: `v1/admin/refund-requests/${ID}/decision`, methods: ["POST"], proxy: "refund" },
  { path: `v1/admin/refund-requests/${ID}/completion`, methods: ["POST"], proxy: "refund" },
  { path: `v1/admin/operations/${ID}/refund-decision`, methods: ["POST"], proxy: "refund" },
  { path: "v1/admin/operator-status", methods: ["GET"], proxy: "operator" },
  { path: "v1/admin/runtime-controls", methods: ["GET", "PUT"], proxy: "operator" },
  { path: "v1/admin/daily-reviews", methods: ["GET", "POST"], proxy: "operator" },
  { path: "v1/admin/withdrawal-requests", methods: ["GET"], proxy: "operator" },
  { path: `v1/admin/withdrawal-requests/${ID}/approval`, methods: ["POST"], proxy: "operator" },
  {
    path: `v1/admin/withdrawal-requests/${ID}/execution`,
    methods: ["GET", "POST"],
    proxy: "operator",
  },
  {
    path: `v1/admin/withdrawal-requests/${ID}/execution/reconcile`,
    methods: ["POST"],
    proxy: "operator",
  },
  { path: "v1/admin/operational-alerts", methods: ["GET"], proxy: "operator" },
  {
    path: `v1/admin/operations/${ID}/resolutions/close-unpaid-review`,
    methods: ["POST"],
    proxy: "operator",
  },
  {
    path: `v1/admin/operations/${ID}/resolutions/reverify-delivery`,
    methods: ["POST"],
    proxy: "operator",
  },
  {
    path: `v1/admin/operations/${ID}/resolutions/return-approved-to-review`,
    methods: ["POST"],
    proxy: "operator",
  },
  { path: `v1/admin/operations/${ID}/resolutions`, methods: ["GET"], proxy: "operator" },
  { path: `v1/admin/operations/${ID}/reconcile-pix`, methods: ["POST"], proxy: "operator" },
  { path: "v1/admin/operator-notifications", methods: ["GET"], proxy: "operator" },
];

const proxies: Record<Proxy, (path: string) => string[]> = {
  document: documentMethods,
  journey: journeyMethods,
  purchase: purchaseMethods,
  refund: refundMethods,
  operator: operatorMethods,
  customerRead: (p) => (isCustomerReadPath(p) ? ["GET"] : []),
};
// Same order as src/routes/api/$.ts: the first proxy that knows a path handles it.
const DISPATCH_ORDER = [
  "document",
  "journey",
  "purchase",
  "refund",
  "operator",
  "customerRead",
] as const;

const SRC = path.resolve(__dirname, "..");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "test" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.server\.ts$/.test(name) ? [full] : [];
  });
}

/** Reads a literal that starts at `start` up to its closing delimiter, skipping `${...}`. */
function readLiteral(text: string, start: number, delimiter: string) {
  let out = "";
  const holes: string[] = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === delimiter) return { out, holes };
    if (delimiter === "`" && ch === "$" && text[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      holes.push(text.slice(i + 2, j - 1));
      out += `\u0000${holes.length - 1}\u0000`;
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return { out, holes };
}
/** Expands placeholders: `a ? "x" : "y"` gives both, query builders end the path, else an id. */
function expand(out: string, holes: string[]): string[] {
  let results = [out];
  holes.forEach((hole, n) => {
    const token = `\u0000${n}\u0000`;
    const ternary = /^[^?]+\?\s*"([^"]*)"\s*:\s*"([^"]*)"\s*$/.exec(hole.trim());
    const query = /[`"']\?/.test(hole) || /query/i.test(hole);
    results = results.flatMap((r) =>
      ternary
        ? [r.replace(token, ternary[1]!), r.replace(token, ternary[2]!)]
        : [r.replace(token, query ? "?" : ID)],
    );
  });
  return results.map((r) => r.replace(/\?.*$/, ""));
}
function normalize(p: string) {
  return p.replace(/^\/?(api\/)?\/?/, "");
}

/** Every backend path literal in browser code, plus the helper indirections. */
function scannedCalls() {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    if (file.includes(`${path.sep}routes${path.sep}api${path.sep}`)) continue;
    const text = readFileSync(file, "utf8");
    const opener = /(["'`])((?:\/api)?\/?v1\/|registration\/)/g;
    let m: RegExpExecArray | null;
    while ((m = opener.exec(text))) {
      const { out, holes } = readLiteral(text, m.index + 1, m[1]!);
      for (const p of expand(out, holes)) found.add(normalize(p));
    }
    // customer-onboarding: act("onboarding/...") → v1/me/onboarding/...
    if (file.endsWith("customer-onboarding.tsx"))
      for (const a of text.matchAll(/void act\(\s*([^,)]+)/g))
        for (const lit of a[1]!.matchAll(/"([^"]+)"/g)) found.add(`v1/me/${lit[1]}`);
    // automatic-purchase: purchaseRequest(token, "quotes" | `quotes/${id}` ...) → v1/me/...
    if (file.endsWith("automatic-purchase.tsx"))
      for (const a of text.matchAll(/purchaseRequest\(\s*\w+,\s*([^,]+),/g))
        for (const lit of a[1]!.matchAll(/["`]([a-z-]+)(\/\$\{[^}]+\})?["`]/g))
          found.add(`v1/me/${lit[1]}${lit[2] ? `/${ID}` : ""}`);
    // documents: request(token, "" | "/requirements" | "/" + id + "/refresh")
    if (file.endsWith(`${path.sep}documents.ts`))
      for (const a of text.matchAll(
        /request\(\s*token,\s*("[^"]*"(?:\s*\+\s*\w+\s*\+\s*"[^"]*")?)/g,
      ))
        found.add(
          "v1/me/onboarding/documents" +
            a[1]!.replace(/"\s*\+\s*\w+\s*\+\s*"/, ID).replace(/"/g, ""),
        );
  }
  // The helpers' own `${path}` prefixes are resolved above.
  found.delete(`v1/me/${ID}`);
  return [...found].filter((p) => !p.startsWith("v1/settlements"));
}

describe("frontend → backend proxy allowlist", () => {
  it("lists every backend path the frontend calls", () => {
    const listed = CALLS.map((c) => c.path);
    const scanned = scannedCalls();
    expect(scanned.length).toBeGreaterThan(30);
    expect(scanned.filter((p) => !listed.includes(p))).toEqual([]);
    expect(listed.filter((p) => !scanned.includes(p))).toEqual([]);
  });

  it.each(CALLS)("$path is carried only by the $proxy proxy with $methods", (call) => {
    const owners = DISPATCH_ORDER.filter((name) => proxies[name](call.path).length > 0);
    expect(owners).toEqual([call.proxy]);
    const allowed = proxies[call.proxy](call.path);
    for (const method of call.methods) expect(allowed).toContain(method);
  });
});

describe("customer cancel through the purchase proxy", () => {
  const base = "https://backend.example.test";
  const cancelPath = `v1/me/purchase-intents/${ID}/cancel`;
  const req = (body: unknown) =>
    new Request(`https://app.example.test/api/${cancelPath}`, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic.token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  afterEach(() => vi.restoreAllMocks());

  it("forwards only {request_id} to the backend", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { cancel_requested: true } }, { status: 200 }));
    const response = await forwardPurchase(
      req({ request_id: ID }),
      new URL(`${base}/${cancelPath}`),
      cancelPath,
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${base}/${cancelPath}`);
    expect(fetchMock.mock.calls[0]![1]!.body).toBe(JSON.stringify({ request_id: ID }));
  });

  it("refuses extra fields or a GET", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const extra = await forwardPurchase(
      req({ request_id: ID, quote_id: ID }),
      new URL(`${base}/${cancelPath}`),
      cancelPath,
    );
    expect(extra.status).toBe(400);
    const get = await forwardPurchase(
      new Request(`https://app.example.test/api/${cancelPath}`),
      new URL(`${base}/${cancelPath}`),
      cancelPath,
    );
    expect(get.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
