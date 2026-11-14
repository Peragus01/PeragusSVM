import type { ComponentType, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  search: {} as { operacao?: string },
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
vi.mock("@/lib/peragus/customer-session", () => ({
  useCustomerSession: () => mocks.session,
  fetchOperatorStatus: async () => true,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => mocks.search }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
import { Route } from "@/routes/operador.estornos";
const Page = Route.options.component as ComponentType;
const id = "22222222-2222-4222-8222-222222222222";
const purchase = "11111111-1111-4111-8111-111111111111";
const requestA = "33333333-3333-4333-8333-333333333333";
const approved = {
  id,
  purchase_intent_id: purchase,
  pix_id: id,
  request_id: id,
  state: "approved",
  reason: "Pedido de teste para analise.",
  requested_amount: { currency: "BRL", amount: "1000.00" },
  created_at: "2026-11-12T12:00:00Z",
  decision_recorded_at: new Date(Date.now() - 13 * 3600_000).toISOString(),
  returned_amount: null,
  partial_refund: null,
  refund_recorded_at: null,
  environment: "test",
  record_only: true,
  refund_execution_automated: false,
  provider_verified: false,
  original_transfer_cancelled: false,
  customer_id: purchase,
  decision: { id, operator_user_id: purchase, reason: "Conferencia manual realizada." },
  completion: null,
  withdrawal_context: { started: false, provider_state: null, requires_manual_funds_review: false },
};
const page = (data: unknown[]) =>
  Response.json({ data, meta: { has_more: false, next_cursor: null } });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.search = {};
});

describe("operator refund console", () => {
  it("highlights the 24 h deadline and records the completion with the OZAV reference", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestA);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(page([approved]))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            ...approved,
            state: "refund_recorded",
            returned_amount: { currency: "BRL", amount: "1000.00" },
            partial_refund: false,
            refund_recorded_at: "2026-11-13T12:00:00Z",
            completion: { id, operator_user_id: purchase, reference: "OZAV-ref-123" },
          },
        }),
      );
    render(<Page />);
    expect(await screen.findByText(/Prazo de 24 h: restam 1\d h/)).toHaveClass(
      "operator-deadline-warn",
    );
    fireEvent.click(screen.getByRole("button", { name: "Analisar pedido" }));
    fireEvent.change(screen.getByLabelText("Valor devolvido (R$)"), {
      target: { value: "1000.00" },
    });
    fireEvent.change(screen.getByLabelText("Referência OZAV"), {
      target: { value: "OZAV-ref-123" },
    });
    expect(screen.getByRole("button", { name: "Registrar devolução" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/devolução foi executada fora da Peragus/));
    fireEvent.click(screen.getByRole("button", { name: "Registrar devolução" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar registro" }));
    await screen.findByText(/Devolução registrada: R\$/);
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `/api/v1/admin/refund-requests/${id}/completion`,
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({
      request_id: requestA,
      amount_brl: "1000.00",
      reference: "OZAV-ref-123",
      confirmation: "MANUAL_REFUND_EXECUTED_EXTERNALLY",
    });
  });

  it("posts the operator refund decision for an operation id taken from the link", async () => {
    mocks.search = { operacao: purchase };
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestA);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              purchase_intent_id: purchase,
              status: "refund_pending",
              refund_request: approved,
            },
            meta: { idempotent_replay: false },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValue(page([]));
    render(<Page />);
    expect(await screen.findByLabelText("ID da operação")).toHaveValue(purchase);
    fireEvent.change(screen.getByLabelText("Motivo do estorno"), {
      target: { value: "Pix pago após o encerramento da operação" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Registrar decisão de estorno" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar estorno" }));
    expect(await screen.findByText(/Operação movida para estorno pendente/)).toBeInTheDocument();
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `/api/v1/admin/operations/${purchase}/refund-decision`,
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({
      request_id: requestA,
      reason: "Pix pago após o encerramento da operação",
    });
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("posts an audited resolution (re-verify delivery) with request_id and reason, and reconciles Pix", async () => {
    mocks.search = { operacao: purchase };
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestA);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              id,
              purchase_id: purchase,
              action: "reverify_delivery",
              from_status: "needs_review",
              to_status: "delivered_verified",
              outcome: "VERIFIED: ok",
              created_at: "2026-11-13T10:00:00Z",
            },
            meta: { idempotent_replay: false },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        Response.json({ data: { purchase_id: purchase, status: "failed", pix_state: "expired" } }),
      )
      .mockResolvedValue(page([]));
    render(<Page />);
    expect(await screen.findByLabelText("ID da operação (resoluções)")).toHaveValue(purchase);
    fireEvent.change(screen.getByLabelText("Motivo da resolução"), {
      target: { value: "RPC devolveu blockTime; verificar de novo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar entrega de novo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText(/needs_review → delivered_verified/)).toBeInTheDocument();
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `/api/v1/admin/operations/${purchase}/resolutions/reverify-delivery`,
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({
      request_id: requestA,
      reason: "RPC devolveu blockTime; verificar de novo",
    });
    fireEvent.click(screen.getByRole("button", { name: "Reconciliar Pix" }));
    expect(await screen.findByText(/Pix reconciliado: operação em failed/)).toBeInTheDocument();
    const reconcile = fetcher.mock.calls.find(
      (c) => String(c[0]) === `/api/v1/admin/operations/${purchase}/reconcile-pix`,
    );
    expect(reconcile?.[1]?.method).toBe("POST");
    expect(reconcile?.[1]?.body).toBeUndefined();
  });
});
