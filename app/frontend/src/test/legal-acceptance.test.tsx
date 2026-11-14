import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationPage } from "@/routes/cadastro";
import { CustomerPix } from "@/components/peragus/customer-pix";
import { LegalAcceptanceGate } from "@/components/peragus/customer-legal-acceptance";
import { journeyRequest } from "@/lib/peragus/journey";
import { journeyMethods } from "@/lib/peragus/journey-proxy.server";

const state = vi.hoisted(() => ({
  status: "unauthenticated",
  identity: { user: { id: "u", email: "client@example.test" }, customer: null },
  accessToken: null as string | null,
}));
vi.mock("@/lib/peragus/customer-session", () => ({
  signUpCustomer: vi.fn(),
  useCustomerSession: () => ({ ...state, configured: true, reloadIdentity: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const sha = (c: string) => c.repeat(64);
const required = [
  { document: "terms", version: "draft-0.9-2026-11-03", sha256: sha("a") },
  { document: "privacy", version: "draft-0.9-2026-11-03", sha256: sha("b") },
  { document: "refund", version: "2026-11-02", sha256: sha("c") },
];
const status = (missing: typeof required) => ({ data: { required, missing } });

beforeEach(() => {
  state.status = "unauthenticated";
  state.accessToken = null;
  vi.stubEnv("VITE_PERAGUS_MONEY_MODE", "live");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("legal acceptance in the frontend", () => {
  it("create account button stays disabled until terms and privacy are checked", () => {
    render(<RegistrationPage />);
    const button = screen.getByRole("button", { name: "Criar minha conta" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Termos de Uso/ }));
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Política de Privacidade/ }));
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Política de Reembolso/ }));
    expect(button).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Termos de Uso/ }));
    expect(button).toBeDisabled();
    for (const [name, href] of [
      ["Termos de Uso", "/legal/termos-de-uso.html"],
      ["Política de Privacidade", "/legal/politica-de-privacidade.html"],
      ["Política de Reembolso", "/legal/politica-de-reembolso.html"],
    ] as const)
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  });

  it("LEGAL_ACCEPTANCE_REQUIRED redirects to the acceptance step and posting it resumes navigation", async () => {
    let accepted = false;
    const calls: { url: string; method: string; body?: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url) === "/api/v1/me/legal-acceptances")
        return method === "POST"
          ? ((accepted = true), Response.json(status([]), { status: 201 }))
          : Response.json(status(accepted ? [] : required));
      return Response.json({ error: { code: "LEGAL_ACCEPTANCE_REQUIRED" } }, { status: 403 });
    });
    // The server already answered GET with nothing missing (stale), then a gated route says otherwise.
    accepted = true;
    render(
      <LegalAcceptanceGate token="synthetic.token">
        <p>Conteúdo da compra</p>
      </LegalAcceptanceGate>,
    );
    expect(await screen.findByText("Conteúdo da compra")).toBeInTheDocument();
    accepted = false;
    await act(async () => {
      await journeyRequest("synthetic.token", "v1/me/purchase-quotes", "POST", {}).catch(() => {});
    });
    expect(
      await screen.findByRole("heading", { name: /Aceite dos documentos/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Conteúdo da compra")).toBeNull();
    const submit = screen.getByRole("button", { name: "Aceitar e continuar" });
    expect(submit).toBeDisabled();
    for (const name of [/Termos de Uso/, /Política de Privacidade/, /Política de Reembolso/])
      fireEvent.click(screen.getByRole("checkbox", { name }));
    fireEvent.click(submit);
    expect(await screen.findByText("Conteúdo da compra")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("legal-acceptances"));
    // Versions come from the server's required list, never hard-coded; no hash is sent.
    expect(post?.body).toEqual({
      documents: [
        { document: "terms", version: "draft-0.9-2026-11-03" },
        { document: "privacy", version: "draft-0.9-2026-11-03" },
        { document: "refund", version: "2026-11-02" },
      ],
    });
  });

  it("shows the acceptance step first when the server already reports missing documents", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(status(required.slice(2))));
    render(
      <LegalAcceptanceGate token="synthetic.token">
        <p>Conteúdo da compra</p>
      </LegalAcceptanceGate>,
    );
    expect(await screen.findByRole("checkbox", { name: /Política de Reembolso/ })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /Termos de Uso/ })).toBeNull();
    expect(screen.queryByText("Conteúdo da compra")).toBeNull();
  });

  it("reports a version mismatch instead of continuing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      if (init?.method === "POST")
        return Response.json({ error: { code: "LEGAL_VERSION_MISMATCH" } }, { status: 409 });
      return Response.json(status(required));
    });
    render(
      <LegalAcceptanceGate token="synthetic.token">
        <p>Conteúdo da compra</p>
      </LegalAcceptanceGate>,
    );
    for (const name of [/Termos de Uso/, /Política de Privacidade/, /Política de Reembolso/])
      fireEvent.click(await screen.findByRole("checkbox", { name }));
    fireEvent.click(screen.getByRole("button", { name: "Aceitar e continuar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/versão/i);
    expect(screen.queryByText("Conteúdo da compra")).toBeNull();
  });

  it("refund policy link is visible before payment instructions", () => {
    render(
      <CustomerPix
        token="synthetic.token"
        purchaseId="d57d1d93-d02c-4141-a278-834bc0dec6e3"
        amount="1000.00"
        enabled
      />,
    );
    const link = screen.getByRole("link", { name: /Política de Reembolso/ });
    expect(link).toHaveAttribute("href", "/legal/politica-de-reembolso.html");
    expect(screen.queryByLabelText("Pix copia e cola")).toBeNull();
  });

  it("proxies the acceptance endpoints for the signed-in customer", () => {
    expect(journeyMethods("v1/me/legal-acceptances")).toEqual(["GET", "POST"]);
  });
});
