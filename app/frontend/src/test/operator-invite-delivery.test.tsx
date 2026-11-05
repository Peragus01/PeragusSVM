import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { InviteConsole } from "@/routes/operador.convites";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("shows queued, accepted, delivered and uncertain distinctly without exposing codes or recipients", async () => {
  const record = {
    id: "11111111-1111-4111-8111-111111111111",
    state: "issued",
    slot: 6,
    created_at: "2026-11-04T12:00:00Z",
    expires_at: "2026-11-05T12:00:00Z",
    reason: "Synthetic invite reason",
    target_user_id: null,
  };
  const pending = {
    ...record,
    email_delivery: {
      state: "pending",
      retry_blocked: false,
      accepted_at: null,
      delivered_at: null,
      last_error: null,
    },
  };
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ data: pending, code: null }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ data: [pending] }))
    .mockResolvedValueOnce(
      Response.json({
        data: [{ ...pending, email_delivery: { ...pending.email_delivery, state: "accepted" } }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: [{ ...pending, email_delivery: { ...pending.email_delivery, state: "delivered" } }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: [
          {
            ...pending,
            email_delivery: { ...pending.email_delivery, state: "uncertain", retry_blocked: true },
          },
        ],
      }),
    );
  render(<InviteConsole token="aal2.token" verifyMfa={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("E-mail do convidado"), {
    target: { value: "test@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Gerar convite" }));
  expect(await screen.findByText("E-mail na fila · ainda não enviado")).toBeInTheDocument();
  expect(screen.queryByText(/Código emitido/)).not.toBeInTheDocument();
  expect(screen.queryByText("test@example.test")).not.toBeInTheDocument();
  for (const label of [
    "Aceito pelo Resend · entrega ainda não confirmada",
    "Entrega confirmada pelo provedor",
    "Resultado incerto · repetição automática bloqueada; consulte o suporte",
  ]) {
    fireEvent.click(screen.getByRole("button", { name: "Atualizar histórico" }));
    expect(await screen.findByText(label)).toBeInTheDocument();
  }
  expect(fetcher).toHaveBeenCalledTimes(5);
});
