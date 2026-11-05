import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CustomerDocumentSummary } from "@/components/peragus/customer-document-summary";
const state = vi.hoisted(() => ({ account: "one", token: "synthetic.token" as string | null }));
vi.mock("@/lib/peragus/customer-session", () => ({
  useCustomerSession: () => ({
    accessToken: state.token,
    identity: { user: { id: state.account }, customer: { id: state.account } },
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.account = "one";
  state.token = "synthetic.token";
});
const record = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  doc_type: "proof_of_address",
  side: "none",
  state: "received",
  environment: "test",
  identity_verified: false,
  operations_enabled: false,
};
const requirements = {
  required_documents: [{ doc_type: "selfie", supported_for_upload: true }],
  environment: "test",
  identity_verified: false,
  operations_enabled: false,
};
describe("document summary", () => {
  it("provides a dedicated-page link and real counts without mounting upload controls or claiming approval", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      Response.json({
        data: String(url).endsWith("/requirements")
          ? requirements
          : [record, { ...record, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "uncertain" }],
      }),
    );
    render(<CustomerDocumentSummary />);
    await waitFor(() => expect(screen.queryByText("Consultando documentos…")).toBeNull());
    expect(screen.getByRole("link", { name: /Enviar e acompanhar documentos/ })).toHaveAttribute(
      "href",
      "/app/documentos",
    );
    expect(screen.getByText("Arquivos recebidos").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Recebimento pendente").nextElementSibling).toHaveTextContent("1");
    expect(screen.queryByLabelText("Arquivo de teste")).toBeNull();
    expect(screen.queryByText(/Aprovado/)).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("clears old private counts when changing accounts and ignores late responses", async () => {
    let release!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/requirements")) return Response.json({ data: requirements });
      if (state.account === "one")
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Response.json({ data: [] });
    });
    const view = render(<CustomerDocumentSummary />);
    state.account = "two";
    view.rerender(<CustomerDocumentSummary />);
    await waitFor(() =>
      expect(screen.getByText("Arquivos recebidos").nextElementSibling).toHaveTextContent("0"),
    );
    release(Response.json({ data: [record] }));
    await waitFor(() =>
      expect(screen.getByText("Arquivos recebidos").nextElementSibling).toHaveTextContent("0"),
    );
  });
  it("does not infer zero documents on an unavailable query", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("private"));
    render(<CustomerDocumentSummary />);
    await screen.findByText(/Não foi possível consultar o resumo/);
    expect(screen.queryByText("Arquivos recebidos")).toBeNull();
    expect(screen.getByRole("link", { name: /Enviar e acompanhar/ })).toBeInTheDocument();
  });
  it("does not fetch private metadata without an authenticated session", () => {
    state.token = null;
    const fetcher = vi.spyOn(globalThis, "fetch");
    render(<CustomerDocumentSummary />);
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
