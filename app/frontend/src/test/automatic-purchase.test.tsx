import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AutomaticPurchaseForm } from "@/components/peragus/automatic-purchase";
const customer = "8877827c-3a86-4eeb-9545-465244a2c0a5",
  qid = "91e9eeb3-1878-4fe7-ba62-9c387c3df45e",
  pid = "d57d1d93-d02c-4141-a278-834bc0dec6e3";
const address = "8BRSnNBGszJCxYJ1xhqsacBVsfM2tr6UdaoBKv52YnxB";
vi.mock("@/components/peragus/customer-wallet-link", () => ({
  CustomerWalletLink: () => null,
  useLinkedWallet: () => ({
    linked: {
      wallet_address: "8BRSnNBGszJCxYJ1xhqsacBVsfM2tr6UdaoBKv52YnxB",
      network: "solana:devnet",
    },
    error: "",
  }),
}));
vi.mock("@/components/peragus/wallet-context", () => ({
  usePeragusWallet: () => ({ address: null, open: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
function quote(
  requestId: string,
  source = "1000.00",
  target = "200.000000",
  expires: string | null = null,
) {
  return {
    id: qid,
    request_id: requestId,
    state: "quoted",
    source: { currency: "BRL", amount: source },
    target: { currency: "USDT", amount: target, chain: "solana" },
    rate: "0.2",
    exchange_conditions: { amount_deducted: "1.52", spread_bps: 0 },
    expires_at: expires,
    environment: "test",
    indicative: true,
    executable: false,
    operations_enabled: false,
    external_delivery_costs_evaluated: false,
  };
}
const caps = {
  environment: "test",
  operations_enabled: false,
  real_purchase: false,
  required_costs_complete: false,
  network: "solana:devnet",
  quote: true,
  record: true,
  pix: false,
};
let custom: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
let fetcher: MockInstance<typeof fetch>;
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  custom = null;
  fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/purchase-capabilities")) return Response.json({ data: caps });
    if (custom) return custom(path, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("/quotes"))
      return Response.json({
        data: quote(
          body.request_id,
          body.target_amount_usdt ? "1000.00" : body.source_amount_brl,
          body.target_amount_usdt ?? "200.000000",
        ),
      });
    if (path.endsWith("/purchase-intents"))
      return Response.json({
        data: {
          id: pid,
          request_id: body.request_id,
          quote_id: qid,
          state: "recorded",
          source: { currency: "BRL", amount: "1000.00" },
          estimated_target: { currency: "USDT", amount: "200.000000", chain: "solana" },
          destination: { wallet_address: address, proof_network: "solana:devnet" },
          environment: "test",
          record_only: true,
          funding_started: false,
          job_enqueued: false,
          operations_enabled: false,
          executable: false,
        },
      });
    throw Error("Unexpected request " + path);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function open(token = "synthetic.token") {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<AutomaticPurchaseForm customerId={customer} token={token} />);
  });
  return view;
}
async function type(side: "BRL" | "USDT", value: string) {
  fireEvent.change(
    screen.getByLabelText(side === "BRL" ? "Você paga" : "Você recebe · estimativa bruta"),
    { target: { value } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}
const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
describe("automatic BRL/USDT purchase", () => {
  it("debounces edits and never requires a quote button or creates a payment while typing", async () => {
    await open();
    expect(posts()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Consultar cotação/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Você paga"), { target: { value: "1000" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fireEvent.change(screen.getByLabelText("Você paga"), { target: { value: "2000" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(posts()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]![1]!.body))).toMatchObject({
      source_amount_brl: "2000.00",
    });
    expect(screen.getByLabelText("Você recebe · estimativa bruta")).toHaveValue("200,000000");
  });
  it("requests target.amount from the backend when USDT is edited", async () => {
    await open();
    await type("USDT", "200,123456");
    expect(JSON.parse(String(posts()[0]![1]!.body))).toMatchObject({
      target_amount_usdt: "200.123456",
    });
    expect(screen.getByLabelText("Você paga")).toHaveValue("1000,00");
    expect(posts()).toHaveLength(1);
  });
  it("ignores old results, serializes provider attempts and quotes the latest edit afterwards", async () => {
    let finish!: (r: Response) => void;
    let oldId = "";
    custom = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (!oldId) {
        oldId = body.request_id;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return Response.json({ data: quote(body.request_id, "2000.00", "400.000000") });
    };
    await open();
    await type("BRL", "1000");
    await type("BRL", "2000");
    expect(posts()).toHaveLength(1);
    await act(async () => {
      finish(Response.json({ data: quote(oldId) }));
    });
    expect(screen.getByLabelText("Você recebe · estimativa bruta")).toHaveValue("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(posts()).toHaveLength(2);
    expect(screen.getByLabelText("Você recebe · estimativa bruta")).toHaveValue("400,000000");
  });
  it("persists IDs before POST and blocks duplicate record submission", async () => {
    await open();
    await type("BRL", "1000");
    expect(sessionStorage.getItem(`peragus-auto-quote-v1:${customer}`)).toContain(qid);
    fireEvent.click(screen.getByRole("button", { name: "Comprar USDT" }));
    expect(posts()).toHaveLength(1);
    const confirm = screen.getByRole("button", { name: "Confirmar registro de teste" });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(posts().map(([url]) => url)).toEqual([
      "/api/v1/me/quotes",
      "/api/v1/me/purchase-intents",
    ]);
    expect(screen.getByRole("heading", { name: "Registro de teste salvo" })).toBeInTheDocument();
    expect(screen.queryByText("USDT entregue")).toBeNull();
  });
  it("freezes an uncertain request and only retries explicitly with the same key", async () => {
    custom = async () => {
      throw Error("timeout");
    };
    await open();
    await type("BRL", "1000");
    const first = JSON.parse(String(posts()[0]![1]!.body));
    await type("BRL", "2000");
    expect(posts()).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Conferir solicitação salva" }));
    });
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(String(posts()[1]![1]!.body))).toEqual(first);
  });
  it("recovers a known legacy quote by GET without another POST", async () => {
    sessionStorage.setItem(
      `peragus-purchase-v1:${customer}`,
      JSON.stringify({
        customerId: customer,
        amount: "1000.00",
        quoteRequestId: qid,
        purchaseRequestId: pid,
        quoteAttempted: true,
        purchaseAttempted: false,
        quoteId: qid,
      }),
    );
    custom = async () => Response.json({ data: quote(qid) });
    await open();
    expect(posts()).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Conferir solicitação salva" }));
    });
    expect(posts()).toHaveLength(0);
    expect(screen.getByLabelText("Você recebe · estimativa bruta")).toHaveValue("200,000000");
  });
  it("does not quote invalid inputs, block writes when storage fails, or accept an expired quote", async () => {
    await open();
    await type("BRL", "50");
    expect(posts()).toHaveLength(0);
    custom = async (_url, init) =>
      Response.json({
        data: quote(
          JSON.parse(String(init?.body)).request_id,
          "1000.00",
          "200.000000",
          "2000-01-01T00:00:00Z",
        ),
      });
    await type("BRL", "1000");
    expect(screen.getByRole("button", { name: "Comprar USDT" })).toBeDisabled();
  });
  it("blocks a POST if its request IDs cannot be persisted", async () => {
    await open();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("storage");
    });
    await type("BRL", "1000");
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
