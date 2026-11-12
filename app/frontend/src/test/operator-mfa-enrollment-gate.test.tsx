import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorInviteArea } from "@/routes/operador.convites";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockBackend(operator: boolean) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/v1/admin/operator-status")
      return Response.json({ data: { operator, mfa_enrolled_required: true } });
    return Response.json({ error: { code: "WITHDRAWAL_OPERATOR_MFA_REQUIRED" } }, { status: 403 });
  });
}

async function askForMfa() {
  fireEvent.change(screen.getByLabelText("E-mail do convidado"), {
    target: { value: "test@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Gerar convite" }));
  expect(await screen.findByText(/Confirme a autenticação multifator/)).toBeInTheDocument();
}

describe("operator MFA enrollment gate", () => {
  it("MFA enrollment is not offered to non-operators", async () => {
    const fetcher = mockBackend(false);
    const enrollMfa = vi.fn();
    render(
      <OperatorInviteArea
        token="aal1.token"
        verifyMfa={vi.fn()}
        enrollMfa={enrollMfa}
        verifyMfaEnrollment={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => url === "/api/v1/admin/operator-status")).toBe(
        true,
      ),
    );
    await askForMfa();
    expect(screen.queryByRole("button", { name: "Configurar autenticador" })).toBeNull();
    expect(enrollMfa).not.toHaveBeenCalled();
  });

  it("offers MFA enrollment to an allowlisted operator", async () => {
    mockBackend(true);
    render(
      <OperatorInviteArea
        token="aal1.token"
        verifyMfa={vi.fn()}
        enrollMfa={vi.fn()}
        verifyMfaEnrollment={vi.fn()}
      />,
    );
    await askForMfa();
    expect(
      await screen.findByRole("button", { name: "Configurar autenticador" }),
    ).toBeInTheDocument();
  });
});
