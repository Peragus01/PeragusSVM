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
});
