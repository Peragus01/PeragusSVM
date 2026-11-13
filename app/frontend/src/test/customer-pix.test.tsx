import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerPix } from "@/components/peragus/customer-pix";

const purchaseId = "d57d1d93-d02c-4141-a278-834bc0dec6e3",
  pixId = "5b0c7f3e-8a1d-4c2b-9e6f-1a2b3c4d5e6f";
const expires = "2099-01-01T12:00:00Z";
function pix(requestId: string, extra: Record<string, unknown> = {}) {
  return {
    id: pixId,
    purchase_intent_id: purchaseId,
    request_id: requestId,
    environment: "live",
    real_money: true,
    operations_enabled: false,
    payment_confirmed: false,
    state: "awaiting_payment",
    status: "awaiting_pix",
    source: { currency: "BRL", amount: "1000.00" },
    payment_instructions: {
      br_code: "000201live-br-code",
      qr_code_image: null,
      expires_at: expires,
    },
    subsequent_delivery: { started: false },
    recovery_required: false,
    ...extra,
  };
}
async function open() {
  await act(async () => {
    render(
      <CustomerPix token="synthetic.token" purchaseId={purchaseId} amount="1000.00" enabled />,
    );
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Gerar ou recuperar Pix" }));
  });
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubEnv("VITE_PERAGUS_MONEY_MODE", "live");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("live customer Pix", () => {
  it("shows the BR Code and expiry from payment_instructions without test copy", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      Response.json({ data: pix(JSON.parse(String(init?.body)).request_id) }, { status: 201 }),
    );
    await open();
    expect(screen.getByLabelText("Pix copia e cola")).toHaveValue("000201live-br-code");
    expect(screen.getByText(/^Validade:/)).toHaveTextContent(
      new Date(expires).toLocaleString("pt-BR"),
    );
    expect(screen.getByText(/^Aguardando pagamento/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/teste/i);
  });
  it.each(["PIX_RATE_LOCK_UNAVAILABLE", "PIX_LOCKED_AMOUNT_MISMATCH"])(
    "explains %s and shows no Pix",
    async (code) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json({ error: { code, automatic_retry: false } }, { status: 409 }),
      );
      await open();
      expect(screen.getByRole("alert")).toHaveTextContent(/Nenhum Pix foi gerado/);
      expect(screen.queryByLabelText("Pix copia e cola")).toBeNull();
      expect(document.body.textContent ?? "").not.toMatch(/teste/i);
    },
  );
  it("explains paused operations and shows no Pix", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { error: { code: "OPERATIONS_PAUSED", key: "new_operations", automatic_retry: false } },
        { status: 503 },
      ),
    );
    await open();
    expect(screen.getByRole("alert")).toHaveTextContent("Operações temporariamente pausadas");
    expect(screen.queryByLabelText("Pix copia e cola")).toBeNull();
  });
  it("shows no instructions for a failed operation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      Response.json({
        data: pix(JSON.parse(String(init?.body)).request_id, {
          status: "failed",
          state: "failed",
          payment_instructions: null,
        }),
      }),
    );
    await open();
    expect(screen.queryByLabelText("Pix copia e cola")).toBeNull();
    expect(screen.getByText(/Operação encerrada/)).toBeInTheDocument();
  });
  it("in live shows instructions only while the operation is awaiting_pix", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      Response.json({
        data: pix(JSON.parse(String(init?.body)).request_id, { status: "accepted" }),
      }),
    );
    await open();
    expect(screen.queryByLabelText("Pix copia e cola")).toBeNull();
  });
});
describe("customer cancel before Pix (policy 7.1)", () => {
  const cancelledAt = "2026-11-12T10:00:00.000Z";
  function mockApi(pixExtra: Record<string, unknown> = {}, cancel?: () => Response) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init?.method ?? "GET", body });
      if (String(url).endsWith(`/purchase-intents/${purchaseId}/cancel`))
        return cancel
          ? cancel()
          : Response.json({
              data: {
                purchase_id: purchaseId,
                status: "awaiting_pix",
                cancel_requested_at: cancelledAt,
              },
              meta: { idempotent_replay: false },
            });
      return Response.json({ data: pix(body?.request_id ?? "", pixExtra) }, { status: 201 });
    });
    return calls;
  }
  async function confirmCancel() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
    });
    expect(screen.getByRole("dialog")).toHaveTextContent(/7\.1/);
    expect(screen.getByRole("dialog")).toHaveTextContent(/7\.2/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar cancelamento" }));
    });
  }
  it("cancels while awaiting payment, hides the QR and explains that a payment still proceeds", async () => {
    const calls = mockApi();
    await open();
    expect(screen.getByLabelText("Pix copia e cola")).toBeInTheDocument();
    await confirmCancel();
    const cancel = calls.find((c) => c.url.endsWith("/cancel"))!;
    expect(cancel.url).toBe(`/api/v1/me/purchase-intents/${purchaseId}/cancel`);
    expect(cancel.method).toBe("POST");
    expect(cancel.body).toEqual({ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(screen.queryByLabelText("Pix copia e cola")).toBeNull();
    expect(
      screen.getByText("Pedido cancelado — se você já pagou, a compra seguirá normalmente."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
  });
  it("can go back from the confirmation without cancelling", async () => {
    const calls = mockApi();
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(false);
    expect(screen.getByLabelText("Pix copia e cola")).toBeInTheDocument();
  });
  it("hides the button once the payment is confirmed", async () => {
    mockApi({
      payment_confirmed: true,
      state: "payment_confirmed",
      status: "pix_confirmed",
      payment_instructions: null,
    });
    await open();
    expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
  });
  it("shows a cancel already recorded by the server and no QR", async () => {
    mockApi({ cancel_requested_at: cancelledAt, payment_instructions: null });
    await open();
    expect(screen.queryByLabelText("Pix copia e cola")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
    expect(screen.getByText(/^Pedido cancelado/)).toBeInTheDocument();
  });
  it("after a cancel withdrawn by payment shows the confirmed payment, not the cancel", async () => {
    mockApi({
      cancel_requested_at: cancelledAt,
      payment_confirmed: true,
      state: "payment_confirmed",
      status: "pix_confirmed",
      payment_instructions: null,
    });
    await open();
    expect(screen.queryByText(/^Pedido cancelado/)).toBeNull();
    expect(screen.getByText(/^Pagamento confirmado/)).toBeInTheDocument();
  });
  it("explains a cancel refused because the Pix was already received", async () => {
    mockApi({}, () =>
      Response.json({ error: { code: "CANCEL_TOO_LATE_PAYMENT_RECEIVED" } }, { status: 409 }),
    );
    await open();
    await confirmCancel();
    expect(screen.getByRole("alert")).toHaveTextContent(/já foi recebido/);
    expect(screen.queryByText(/^Pedido cancelado/)).toBeNull();
  });
  it("offers the cancel before any Pix exists and expires the order", async () => {
    const calls = mockApi({}, () =>
      Response.json({
        data: { purchase_id: purchaseId, status: "expired", cancel_requested_at: cancelledAt },
      }),
    );
    await act(async () => {
      render(
        <CustomerPix token="synthetic.token" purchaseId={purchaseId} amount="1000.00" enabled />,
      );
    });
    await confirmCancel();
    expect(calls.filter((c) => !c.url.endsWith("/cancel"))).toHaveLength(0);
    expect(screen.getByText(/^Pedido cancelado/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar ou recuperar Pix" })).toBeDisabled();
  });
});
