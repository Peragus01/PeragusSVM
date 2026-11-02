import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { CustomerDocuments } from "@/components/peragus/customer-documents";
import { validateDocumentFile } from "@/lib/peragus/documents";
let account = "one";
vi.mock("@/lib/peragus/customer-session", () => ({
  useCustomerSession: () => ({
    accessToken: "synthetic.token",
    identity: { user: { id: account }, customer: { id: account } },
  }),
}));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const record = {
  id,
  doc_type: "identity_document",
  side: "front",
  state: "received",
  environment: "test",
  identity_verified: false,
  operations_enabled: false,
};
const requirements = (required_documents: unknown) => ({
  required_documents,
  environment: "test",
  identity_verified: false,
  operations_enabled: false,
});
function mock(
  required: unknown = [{ doc_type: "identity_document", supported_for_upload: true }],
  send?: () => Promise<Response>,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/requirements"))
      return Response.json({ data: requirements(required) });
    if (init?.method === "POST") return send ? send() : Response.json({ data: record });
    return Response.json({ data: [] });
  });
}
beforeEach(() => {
  account = "one";
  vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("private document journey", () => {
  it("loads without writes, requires synthetic confirmation, sends one raw file, never approves KYC", async () => {
    const fetcher = mock();
    render(<CustomerDocuments />);
    const button = await screen.findByRole("button", { name: "Enviar arquivo de teste" });
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect(button).toBeDisabled();
    const file = new File(["synthetic"], "test.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText("Arquivo de teste"), { target: { files: [file] } });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findAllByText("Arquivo recebido — análise pendente");
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]?.body).toBe(file);
    expect(writes[0]?.[1]?.headers).toMatchObject({
      "Idempotency-Key": id,
      "X-Document-Type": "identity_document",
      "Content-Type": "image/jpeg",
    });
    expect(screen.getByText(/não conclui a análise de identidade/)).toBeInTheDocument();
    expect(screen.queryByText(/Aprovado/)).toBeNull();
  });
  it("distinguishes unknown requirements, explicit empty requirements and unsupported liveness", async () => {
    const fetcher = mock(null);
    const view = render(<CustomerDocuments />);
    await screen.findByText(/lista de documentos necessários está indisponível/);
    expect(screen.queryByLabelText("Arquivo de teste")).toBeNull();
    view.unmount();
    fetcher.mockRestore();
    mock([]);
    const empty = render(<CustomerDocuments />);
    await screen.findByText(/Nenhum arquivo pendente/);
    expect(screen.queryByLabelText("Arquivo de teste")).toBeNull();
    empty.unmount();
    vi.restoreAllMocks();
    mock([{ doc_type: "liveness", supported_for_upload: false }]);
    render(<CustomerDocuments />);
    await screen.findByText(/Prova de vida/);
    expect(screen.queryByLabelText("Arquivo de teste")).toBeNull();
  });
  it("shows disabled feature without upload controls", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: { code: "CUSTOMER_DOCUMENTS_DISABLED" } }, { status: 503 }),
    );
    render(<CustomerDocuments />);
    await screen.findByText(/envio de arquivos ainda não está disponível/);
    expect(screen.queryByLabelText("Arquivo de teste")).toBeNull();
  });
  it("keeps ambiguous sends locked and only consults afterwards", async () => {
    const fetcher = mock(undefined, async () => {
      throw Error("private upstream url");
    });
    render(<CustomerDocuments />);
    const button = await screen.findByRole("button", { name: "Enviar arquivo de teste" });
    fireEvent.change(screen.getByLabelText("Arquivo de teste"), {
      target: { files: [new File(["x"], "x.jpg", { type: "image/jpeg" })] },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    await screen.findByText(/O envio teve resultado incerto/);
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Atualizar envios" }));
    await waitFor(() => expect(fetcher.mock.calls.length).toBe(5));
    expect(button).toBeDisabled();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.queryByText(/private upstream url/)).toBeNull();
  });
  it("resets private state on account change and selects supported selfie-only requirement", async () => {
    mock([{ doc_type: "selfie", supported_for_upload: true }]);
    const view = render(<CustomerDocuments />);
    await screen.findByLabelText("Arquivo de teste");
    expect(screen.getByLabelText("Tipo de documento")).toHaveValue("selfie");
    fireEvent.change(screen.getByLabelText("Arquivo de teste"), {
      target: { files: [new File(["x"], "x.jpg", { type: "image/jpeg" })] },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    account = "two";
    view.rerender(<CustomerDocuments />);
    await screen.findByLabelText("Arquivo de teste");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Enviar arquivo de teste" })).toBeDisabled();
  });
  it("reconciles an existing uncertain record without declaring another upload", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/requirements"))
        return Response.json({
          data: requirements([{ doc_type: "identity_document", supported_for_upload: true }]),
        });
      if (String(url).endsWith("/refresh") && init?.method === "POST")
        return Response.json({ data: record });
      return Response.json({ data: [{ ...record, state: "uncertain" }] });
    });
    render(<CustomerDocuments />);
    await screen.findByText("Resultado do envio não confirmado");
    expect(screen.getByRole("button", { name: "Enviar arquivo de teste" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Consultar recebimento" }));
    await screen.findAllByText("Arquivo recebido — análise pendente");
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.[0])).toBe("/api/v1/me/onboarding/documents/" + id + "/refresh");
    expect(writes[0]?.[1]?.body).toBeUndefined();
  });
  it("rejects oversized and inappropriate files before writes", () => {
    expect(
      validateDocumentFile(new File(["x"], "x.pdf", { type: "application/pdf" }), "selfie"),
    ).toMatch(/Formato inválido/);
    expect(
      validateDocumentFile(
        new File([new Uint8Array(4 * 1024 * 1024 + 1)], "x.png", { type: "image/png" }),
        "selfie",
      ),
    ).toMatch(/4 MiB/);
  });
});
