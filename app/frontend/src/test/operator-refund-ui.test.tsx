import type { ComponentType, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: {
    status: "authenticated",
    identity: { user: { id: "operator" }, customer: null as null | { id: string } },
    accessToken: "synthetic.aal2",
    configured: true,
    login: vi.fn(),
    logout: vi.fn(),
    verifyOperatorMfa: vi.fn(),
    enrollOperatorMfa: vi.fn(),
    verifyOperatorMfaEnrollment: vi.fn(),
  },
}));
vi.mock("@/lib/peragus/customer-session", () => ({ useCustomerSession: () => mocks.session }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
import { Route } from "@/routes/operador.estornos";
const Page = Route.options.component as ComponentType;
const id = "22222222-2222-4222-8222-222222222222";
const purchase = "11111111-1111-4111-8111-111111111111";
const row = {
  id,
  purchase_intent_id: purchase,
  pix_id: id,
  request_id: id,
  state: "pending_review",
  reason: "Pedido de teste para analise.",
  requested_amount: { currency: "BRL", amount: "1000.00" },
  created_at: "2026-10-24T12:00:00Z",
  decision_recorded_at: null,
  returned_amount: null,
  partial_refund: null,
  refund_recorded_at: null,
  environment: "test",
  record_only: true,
  refund_execution_automated: false,
  provider_verified: false,
  original_transfer_cancelled: false,
  customer_id: purchase,
  decision: null,
  completion: null,
  withdrawal_context: {
    started: true,
    provider_state: "completed",
    requires_manual_funds_review: true,
  },
};
const page = (data: unknown[]) =>
  Response.json({ data, meta: { has_more: false, next_cursor: null } });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.session.identity.customer = null;
});
describe("operator refund screen", () => {
  it("does not query operator data using a customer profile", () => {
    mocks.session.identity.customer = { id: purchase };
    const fetcher = vi.spyOn(globalThis, "fetch");
    render(<Page />);
    expect(screen.getByText(/Esta conta possui perfil de cliente/)).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("asks for MFA after the backend denies an aal1 session", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ error: { code: "WITHDRAWAL_OPERATOR_MFA_REQUIRED" } }, { status: 403 }),
      )
      .mockResolvedValue(page([]));
    render(<Page />);
    fireEvent.change(await screen.findByLabelText("Código do autenticador"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar MFA" }));
    await waitFor(() => expect(mocks.session.verifyOperatorMfa).toHaveBeenCalledWith("123456"));
    await screen.findByText("Nenhum pedido nesta página.");
  });
  it("requires explicit funds review before posting a decision and never calls completion", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(purchase);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(page([row]))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            ...row,
            state: "approved",
            decision: { id, operator_user_id: purchase, reason: "Conferencia manual realizada." },
          },
        }),
      );
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "Analisar pedido" }));
    expect(screen.getByText(/A retirada já foi iniciada/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Decisão"), { target: { value: "approved" } });
    fireEvent.change(screen.getByLabelText("Motivo interno"), {
      target: { value: "Conferencia manual realizada." },
    });
    expect(screen.getByRole("button", { name: "Registrar decisão" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Registrar decisão" }));
    await screen.findByText(/Devolução pendente. A execução externa/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`/api/v1/admin/refund-requests/${id}/decision`);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({
      decision: "approved",
      confirmation: "MANUAL_REVIEW_COMPLETED",
    });
  });
  async function decideApproved() {
    fireEvent.click(await screen.findByRole("button", { name: "Analisar pedido" }));
    fireEvent.change(screen.getByLabelText("Decisão"), { target: { value: "approved" } });
    fireEvent.change(screen.getByLabelText("Motivo interno"), {
      target: { value: "Conferencia manual realizada." },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Registrar decisão" }));
  }
  const stale = () => Response.json({ error: { code: "OPERATOR_MFA_STALE" } }, { status: 403 });
  it("on OPERATOR_MFA_STALE asks for a current TOTP, re-verifies and retries the same request once with the new token", async () => {
    mocks.session.verifyOperatorMfa.mockResolvedValueOnce("synthetic.fresh");
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(page([row]))
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(
        Response.json({
          data: {
            ...row,
            state: "approved",
            decision: { id, operator_user_id: purchase, reason: "Conferencia manual realizada." },
          },
        }),
      );
    render(<Page />);
    await decideApproved();
    expect(await screen.findByText(/confirme um código atual do autenticador/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Código atual do autenticador"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e repetir" }));
    await screen.findByText(/Devolução pendente. A execução externa/);
    expect(mocks.session.verifyOperatorMfa).toHaveBeenCalledWith("654321");
    expect(fetcher).toHaveBeenCalledTimes(3);
    const first = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    const retry = JSON.parse(String(fetcher.mock.calls[2]![1]?.body));
    expect(retry.request_id).toBe(first.request_id);
    expect(new Headers(fetcher.mock.calls[2]![1]?.headers).get("authorization")).toBe(
      "Bearer synthetic.fresh",
    );
  });
  it("retries only once: a second OPERATOR_MFA_STALE is shown without another automatic attempt", async () => {
    mocks.session.verifyOperatorMfa.mockResolvedValueOnce("synthetic.fresh");
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(page([row]))
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(stale());
    render(<Page />);
    await decideApproved();
    fireEvent.change(await screen.findByLabelText("Código atual do autenticador"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e repetir" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/confirme um código atual do autenticador/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Código atual do autenticador")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
