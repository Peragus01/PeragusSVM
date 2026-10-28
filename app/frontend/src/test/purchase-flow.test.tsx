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
  it("persists IDs before POST, blocks double submission and only records an intention", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const saved = readPurchasePlan(id)!;
      expect(saved).not.toBeNull();
      expect(init?.credentials).toBe("same-origin");
      return Response.json({
        data: String(url).endsWith("/quotes") ? quote(saved) : purchase(saved),
      });
    });
    render(<PurchaseForm customerId={id} token="synthetic.token" />);
    fireEvent.change(screen.getByLabelText(/Quanto deseja/), { target: { value: "1000,00" } });
    const button = screen.getByRole("button", { name: "Consultar cotação sandbox" });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText("184.610000 USDT · Solana");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Registrar intenção sandbox" }));
    await screen.findByText(/Intenção registrada:/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      "/api/v1/me/quotes",
      "/api/v1/me/purchase-intents",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      request_id: readPurchasePlan(id)!.purchaseRequestId,
      quote_id: qid,
    });
  });
  it("does not automatically retry an unknown result and preserves the same request key", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<PurchaseForm customerId={id} token="synthetic.token" />);
    fireEvent.change(screen.getByLabelText(/Quanto deseja/), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar cotação sandbox" }));
    await screen.findByRole("alert");
    const first = readPurchasePlan(id)!.quoteRequestId;
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Consultar cotação desta intenção" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(readPurchasePlan(id)!.quoteRequestId).toBe(first);
  });
  it("recovers a known quote through GET after remount without POST", async () => {
    sessionStorage.setItem(`peragus-purchase-v1:${id}`, JSON.stringify({ ...plan, quoteId: qid }));
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: quote() }));
    render(<PurchaseForm customerId={id} token="synthetic.token" />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Consultar cotação desta intenção" }));
    await screen.findByText("184.610000 USDT · Solana");
    expect(fetcher.mock.calls[0]![1]!.method).toBe("GET");
  });
  it("discards an old token's response after the session changes", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<PurchaseForm customerId={id} token="first.token" />);
    fireEvent.change(screen.getByLabelText(/Quanto deseja/), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar cotação sandbox" }));
    const saved = readPurchasePlan(id)!;
    view.rerender(<PurchaseForm customerId={id} token="second.token" />);
    finish(Response.json({ data: quote(saved) }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Registrar intenção sandbox" })).toBeNull();
  });
  it("blocks expired quotes before recording and does not infer a purchase", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({
          data: { ...quote(readPurchasePlan(id)!), expires_at: "2000-01-01T00:00:00Z" },
        }),
      );
    render(<PurchaseForm customerId={id} token="synthetic.token" />);
    fireEvent.change(screen.getByLabelText(/Quanto deseja/), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar cotação sandbox" }));
    await screen.findByRole("button", { name: "Registrar intenção sandbox" });
    fireEvent.click(screen.getByRole("button", { name: "Registrar intenção sandbox" }));
    await screen.findByText(/A cotação expirou/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readPurchasePlan(id)!.purchaseAttempted).toBe(false);
  });
  it("blocks writes when IDs cannot be stored", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("storage");
    });
    const fetcher = vi.spyOn(globalThis, "fetch");
    render(<PurchaseForm customerId={id} token="synthetic.token" />);
    fireEvent.change(screen.getByLabelText(/Quanto deseja/), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar cotação sandbox" }));
    await screen.findByRole("alert");
    expect(fetcher).not.toHaveBeenCalled();
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
