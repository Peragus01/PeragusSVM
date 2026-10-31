import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerOnboarding } from "@/components/peragus/customer-onboarding";
vi.mock("@/lib/peragus/customer-session", () => ({
  useCustomerSession: () => ({
    accessToken: "synthetic.token",
    identity: { user: { id: "user" }, customer: { id: "customer" } },
  }),
}));
afterEach(() => vi.restoreAllMocks());
describe("resumable required KYC", () => {
  it("resumes stored onboarding without creating a duplicate customer or simulating approval", async () => {
    let verification: object | null = null;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith("/individual")) return Response.json({ data: null });
      if (path.endsWith("/terms")) return Response.json({ data: null });
      if (path.endsWith("/screening")) return Response.json({ data: null });
      if (path.endsWith("/onboarding")) return Response.json({ data: { state: "linked" } });
      if (path.endsWith("/verification/refresh")) {
        verification = {
          status: "completed",
          identity_outcome: "approved",
          session_url: null,
          environment: "test",
          sandbox_only: true,
        };
        return Response.json({ data: verification });
      }
      if (path.endsWith("/verification")) {
        if (init?.method === "POST")
          verification = {
            status: "pending",
            identity_outcome: null,
            session_url: null,
            environment: "test",
            sandbox_only: true,
          };
        return Response.json({ data: verification });
      }
      throw Error("Unexpected request " + path);
    });
    const view = render(<CustomerOnboarding />);
    await screen.findByRole("button", { name: "Iniciar verificação de identidade" });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar verificação de identidade" }));
    await screen.findByText(/A OZAV não disponibiliza captura hospedada/);
    expect(screen.queryByRole("button", { name: "Iniciar verificação de identidade" })).toBeNull();
    view.unmount();
    render(<CustomerOnboarding />);
    await screen.findByRole("button", { name: "Atualizar verificação" });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Atualizar verificação" }));
    await screen.findByText("Aprovado em teste");
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2),
    );
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/simulate"))).toBe(false);
    expect(screen.getByText(/não autoriza transações reais/)).toBeInTheDocument();
  });
});
