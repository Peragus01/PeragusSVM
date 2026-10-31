import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PurchaseForm } from "@/routes/app.comprar-usdt";
import {
  normalizePurchaseAmount,
  readPurchasePlan,
  validateQuote,
  validatePurchase,
  type PurchasePlan,
} from "@/lib/peragus/purchase";
import { forwardPurchase, purchaseMethods } from "@/lib/peragus/purchase-proxy.server";
vi.mock("@tanstack/react-router", async (original) => {
  const actual = await original<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children }: { children: import("react").ReactNode }) => <span>{children}</span>,
  };
});
const id = "8877827c-3a86-4eeb-9545-465244a2c0a5";
const qid = "91e9eeb3-1878-4fe7-ba62-9c387c3df45e";
const pid = "d57d1d93-d02c-4141-a278-834bc0dec6e3";
const plan: PurchasePlan = {
  customerId: id,
  amount: "1000.00",
  quoteRequestId: qid,
  purchaseRequestId: pid,
  quoteAttempted: true,
  purchaseAttempted: false,
};
function quote(p = plan) {
  return {
    id: qid,
    request_id: p.quoteRequestId,
    state: "quoted",
    source: { currency: "BRL", amount: p.amount },
    target: { currency: "USDT", amount: "184.610000", chain: "solana" },
    rate: "0.18461",
    expires_at: null,
    environment: "test",
    indicative: true,
    executable: false,
    operations_enabled: false,
    external_delivery_costs_evaluated: false,
  };
}
function purchase(p = plan) {
  return {
    id: pid,
    request_id: p.purchaseRequestId,
    quote_id: qid,
    source: { currency: "BRL", amount: p.amount },
    estimated_target: quote(p).target,
    state: "recorded",
    environment: "test",
    record_only: true,
    funding_started: false,
    job_enqueued: false,
    operations_enabled: false,
    executable: false,
  };
}
vi.mock("@/components/peragus/onboarding-evidence", () => ({ OnboardingEvidence: () => null }));
vi.mock("@/lib/peragus/customer-session", () => ({ useCustomerSession: () => ({}) }));
vi.mock("@/components/peragus/wallet-context", () => ({ usePeragusWallet: () => ({}) }));
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());
describe("sandbox purchase flow", () => {
  it("accepts the current minimum without the obsolete 500 ceiling", () => {
    expect(normalizePurchaseAmount("500")).toBeNull();
    expect(normalizePurchaseAmount("1000,00")).toBe("1000.00");
    expect(normalizePurchaseAmount("20000")).toBe("20000.00");
    expect(normalizePurchaseAmount("1.000,00")).toBeNull();
  });
  it("rejects changed monetary and execution evidence", () => {
    expect(() =>
      validateQuote({ ...quote(), source: { currency: "BRL", amount: "999.00" } }, plan),
    ).toThrow();
    expect(() => validateQuote({ ...quote(), environment: "production" }, plan)).toThrow();
    const q = validateQuote(quote(), plan);
    expect(() => validatePurchase({ ...purchase(), funding_started: true }, plan, q)).toThrow();
    expect(() =>
      validatePurchase(
        { ...purchase(), estimated_target: { ...q.target, amount: "999" } },
        plan,
        q,
      ),
    ).toThrow();
  });
  it("preserves reported deductions, rejects malformed costs and ignores a browser destination", () => {
    const withCost = { ...quote(), exchange_conditions: { amount_deducted: "1.52" } };
    expect(validateQuote(withCost, plan).exchange_conditions?.amount_deducted).toBe("1.52");
    expect(() =>
      validateQuote({ ...withCost, exchange_conditions: { amount_deducted: "free" } }, plan),
    ).toThrow();
    expect(validateQuote(quote(), plan).exchange_conditions).toBeUndefined();
    expect(() =>
      validatePurchase(
        {
          ...purchase(),
          destination: { wallet_address: "not-an-address", proof_network: "solana:devnet" },
        },
        plan,
        validateQuote(quote(), plan),
      ),
    ).toThrow();
    expect(() =>
      validatePurchase(
        {
          ...purchase(),
          destination: {
            wallet_address: "8BRSnNBGszJCxYJ1xhqsacBVsfM2tr6UdaoBKv52YnxB",
            proof_network: "solana:mainnet",
          },
        },
        plan,
        validateQuote(quote(), plan),
      ),
    ).toThrow();
  });
});
describe("purchase proxy", () => {
  function request(body: object) {
    return new Request("https://preview.example/api/v1/me/quotes", {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic.token",
        "Content-Type": "application/json",
        Cookie: "secret-cookie",
      },
      body: JSON.stringify(body),
    });
  }
  it("allows only exact quote and intention paths", () => {
    expect(purchaseMethods("v1/me/quotes")).toEqual(["POST"]);
    expect(purchaseMethods(`v1/me/quotes/${qid}`)).toEqual(["GET"]);
    expect(purchaseMethods("v1/me/pix")).toEqual([]);
    expect(purchaseMethods("v1/me/quotes/foreign")).toEqual([]);
  });
  it("rejects selectors and oversized bodies before contacting the API", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const body of [
      { request_id: qid, source_amount_brl: "1000.00", customer_id: id },
      { padding: "x".repeat(5000) },
    ]) {
      const response = await forwardPurchase(
        request(body),
        new URL("https://backend.example/v1/me/quotes"),
        "v1/me/quotes",
      );
      expect([400, 413]).toContain(response.status);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("forwards bearer without cookies and rejects upstream redirects", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ data: quote() }, { headers: { "Set-Cookie": "private" } }),
      );
    const response = await forwardPurchase(
      request({ request_id: qid, source_amount_brl: "1000.00" }),
      new URL("https://backend.example/v1/me/quotes"),
      "v1/me/quotes",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const options = fetcher.mock.calls[0]![1]!;
    expect(options.credentials).toBe("omit");
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).get("cookie")).toBeNull();
  });
});
