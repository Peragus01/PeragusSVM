import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteConsole } from "@/routes/operador.convites";

const issuedInvite = {
  id: "11111111-1111-4111-8111-111111111111",
  state: "issued",
  slot: 6,
  created_at: "2026-11-01T18:00:00.000Z",
  expires_at: "2026-11-02T18:00:00.000Z",
  reason: "Convite autorizado pelo operador Peragus",
  target_user_id: null,
};
const success = () =>
  Response.json({ data: issuedInvite, code: "pginv_test_code" }, { status: 201 });
const history = () => Response.json({ data: [] });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("operator invitation MFA flow", () => {
  it("handles a definitive MFA denial without a false unknown outcome, then uses the new AAL2 token", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    fetcher
      .mockResolvedValueOnce(
        Response.json({ error: { code: "WITHDRAWAL_OPERATOR_MFA_REQUIRED" } }, { status: 403 }),
      )
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(history());

    const verifyMfa = vi.fn().mockResolvedValue(undefined);
    const view = render(<InviteConsole token="aal1.token" verifyMfa={verifyMfa} />);
    fireEvent.change(screen.getByLabelText("E-mail do convidado"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Gerar convite" }));

    expect(await screen.findByText(/Confirme a autenticação multifator/)).toBeInTheDocument();
    expect(screen.queryByText(/Resultado incerto/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("E-mail do convidado")).not.toBeDisabled();
    const firstRequest = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));

    fireEvent.change(screen.getByLabelText("Código do autenticador"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar MFA" }));
    await waitFor(() => expect(verifyMfa).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText(/MFA confirmado/)).toBeInTheDocument();
    // Verifying MFA must not refresh using the previously captured AAL1 token.
    expect(fetcher).toHaveBeenCalledTimes(1);

    view.rerender(<InviteConsole token="aal2.token" verifyMfa={verifyMfa} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerar convite" }));
    expect(await screen.findByText(/Código emitido/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer aal2.token",
    );
    const nextRequest = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(nextRequest.request_id).not.toBe(firstRequest.request_id);
    expect(nextRequest.target_email).toBe("test@example.com");
  });

  it("retries an uncertain request using the same idempotency key", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    fetcher.mockRejectedValueOnce(Error("network")).mockResolvedValueOnce(success());
    fetcher.mockResolvedValueOnce(history());

    render(<InviteConsole token="aal2.token" verifyMfa={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("E-mail do convidado"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Gerar convite" }));
    expect(await screen.findByText(/Resultado incerto/)).toBeInTheDocument();
    expect(screen.getByLabelText("E-mail do convidado")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Gerar convite" }));
    expect(await screen.findByText(/Código emitido/)).toBeInTheDocument();

    const first = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(second.request_id).toBe(first.request_id);
    expect(second.target_email).toBe(first.target_email);
  });
});
