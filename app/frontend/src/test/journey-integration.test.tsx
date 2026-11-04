import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { RegistrationPage } from "@/routes/cadastro";
import { forwardJourney, journeyMethods } from "@/lib/peragus/journey-proxy.server";
import { CustomerProfileEditor } from "@/components/peragus/customer-profile-editor";
const state = vi.hoisted(() => ({
  status: "unauthenticated",
  identity: {
    user: { id: "test-user", email: "client@example.test" },
    customer: null as null | { id: string; display_name: string },
  },
  accessToken: null as string | null,
  signup: vi.fn(),
  reload: vi.fn(),
}));
vi.mock("@/lib/peragus/customer-session", () => ({
  signUpCustomer: state.signup,
  useCustomerSession: () => ({ ...state, configured: true, reloadIdentity: state.reload }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/components/peragus/customer-onboarding", () => ({
  CustomerOnboarding: () => <div>KYC obrigatório integrado</div>,
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.status = "unauthenticated";
  state.accessToken = null;
  state.identity.customer = null;
  sessionStorage.clear();
  state.signup.mockResolvedValue(undefined);
  state.reload.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
describe("invited registration", () => {
  it("requires both legal acknowledgements before account signup", async () => {
    render(<RegistrationPage />);
    fireEvent.change(screen.getByLabelText("Código de convite"), {
      target: { value: "pginv_" + "a".repeat(43) },
    });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "client@example.test" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "synthetic-password" } });
    const submit = screen.getByRole("button", { name: "Criar minha conta" });
    const terms = screen.getByRole("checkbox", { name: /Termos de Uso/ });
    const privacy = screen.getByRole("checkbox", { name: /Política de Privacidade/ });
    expect(submit).toBeDisabled();
    expect(terms).not.toBeChecked();
    expect(privacy).not.toBeChecked();
    fireEvent.click(terms);
    expect(submit).toBeDisabled();
    fireEvent.click(privacy);
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(state.signup).toHaveBeenCalledWith(
        "client@example.test",
        "synthetic-password",
        "pginv_" + "a".repeat(43),
        {
          termsAccepted: true,
          privacyAcknowledged: true,
          termsVersion: "draft-0.9-2026-11-03",
          privacyVersion: "draft-0.9-2026-11-03",
        },
      ),
    );
    expect(sessionStorage.length).toBe(0);
    expect(await screen.findByText(/O convite ainda não foi consumido/)).toBeInTheDocument();
  });
  it("does not show signup success if server rejects the invitation", async () => {
    state.signup.mockRejectedValueOnce(new Error("PILOT_INVITE_NOT_AVAILABLE"));
    render(<RegistrationPage />);
    fireEvent.change(screen.getByLabelText("Código de convite"), {
      target: { value: "pginv_" + "a".repeat(43) },
    });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "client@example.test" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Termos de Uso/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Política de Privacidade/ }));
    fireEvent.click(screen.getByRole("button", { name: "Criar minha conta" }));
    await screen.findByRole("alert");
    expect(state.signup).toHaveBeenCalledOnce();
    expect(screen.queryByText(/O convite ainda não foi consumido/)).not.toBeInTheDocument();
  });
  it("presents mandatory onboarding once a confirmed account has redeemed its invite", () => {
    state.status = "authenticated";
    state.accessToken = "test.token";
    state.identity.customer = { id: "customer", display_name: "Client" };
    render(<RegistrationPage />);
    expect(screen.getByText("KYC obrigatório integrado")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /operador/i })).toBeNull();
  });
  it("updates only the display name and reloads server identity", async () => {
    state.status = "authenticated";
    state.accessToken = "test.token";
    state.identity.customer = { id: "customer", display_name: "Client" };
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { display_name: "New nickname" } }));
    render(<CustomerProfileEditor />);
    fireEvent.change(screen.getByLabelText("Nome de exibição"), {
      target: { value: "New nickname" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(state.reload).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      display_name: "New nickname",
      expected_display_name: "Client",
    });
    expect(fetcher.mock.calls[0]![1]!.method).toBe("PATCH");
  });
  it("keeps the saved confirmation after server identity updates the nickname", async () => {
    state.status = "authenticated";
    state.accessToken = "test.token";
    state.identity.customer = { id: "customer", display_name: "Before" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: { display_name: "After" } }),
    );
    const view = render(<CustomerProfileEditor />);
    state.reload.mockImplementation(async () => {
      state.identity.customer = { id: "customer", display_name: "After" };
      view.rerender(<CustomerProfileEditor />);
    });
    fireEvent.change(screen.getByLabelText("Nome de exibição"), { target: { value: "After" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    expect(await screen.findByText("Nome de exibição atualizado.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome de exibição")).toHaveValue("After");
  });
});
describe("narrow journey proxy", () => {
  it("rejects unrelated administrative and simulation resources", () => {
    for (const path of [
      "v1/admin/refund-requests",
      "v1/me/onboarding/verification/simulate",
      "v1/me/sandbox-pix/id/simulate",
    ])
      expect(journeyMethods(path)).toEqual([]);
  });
  it("strips cookies, authorization and untrusted forwarding headers on public validation", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { valid: true } }));
    const body = { code: "pginv_" + "a".repeat(43), email: "client@example.test" };
    const response = await forwardJourney(
      new Request("https://preview.example/api/registration/invite/check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "secret",
          Authorization: "Bearer private.token",
          "X-Forwarded-For": "spoofed",
        },
        body: JSON.stringify(body),
      }),
      new URL("https://backend.example/registration/invite/check"),
      "registration/invite/check",
    );
    expect(response.status).toBe(200);
    const headers = new Headers(fetcher.mock.calls[0]![1]!.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("requires bearer auth, rejects query selectors and caps streamed request bodies", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect(
      (
        await forwardJourney(
          new Request("https://preview.example/api/v1/me/wallet"),
          new URL("https://backend.example/v1/me/wallet"),
          "v1/me/wallet",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await forwardJourney(
          new Request("https://preview.example/api/v1/me/wallet"),
          new URL("https://backend.example/v1/me/wallet?customer=foreign"),
          "v1/me/wallet",
        )
      ).status,
    ).toBe(400);
    const req = new Request("https://preview.example/api/registration/invite/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "a".repeat(17000) }),
    });
    expect(
      (
        await forwardJourney(
          req,
          new URL("https://backend.example/registration/invite/check"),
          "registration/invite/check",
        )
      ).status,
    ).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
