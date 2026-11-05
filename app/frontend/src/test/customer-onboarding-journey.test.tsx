import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerOnboarding } from "@/components/peragus/customer-onboarding";
vi.mock("@/lib/peragus/customer-session", () => ({
  useCustomerSession: () => ({
    accessToken: "synthetic.token",
    identity: { user: { id: "user" }, customer: { id: "customer" } },
  }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const syntheticIndividual = {
  legal_name: "Pessoa Sintética de Teste",
  cpf: "52998224725",
  date_of_birth: "1990-01-01",
  nationality: "BR",
  phone: { country_code: "+55", number: "11999990000" },
  residential_address: {
    line1: "Rua de Teste",
    number: "10",
    neighborhood: "Centro",
    city: "São Paulo",
    state: "SP",
    postal_code: "01001000",
    country: "BR",
  },
  source_of_funds: "Salário",
  monthly_income_usd: 400,
  expected_monthly_volume_usd: 300,
};
function mockDraft(save: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/individual"))
      return init?.method === "PUT"
        ? save()
        : Response.json({ data: { version: 1, individual: syntheticIndividual } });
    return Response.json({ data: null });
  });
}
async function submitDraft() {
  const name = await screen.findByLabelText("Nome completo");
  fireEvent.submit(name.closest("form")!);
}
describe("individual draft field errors", () => {
  it("connects backend errors to visible fields, focuses the first in form order and preserves values", async () => {
    const scroll = vi.fn();
    mockDraft(() =>
      Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            fields: [
              "individual.residential_address.postal_code",
              "individual.phone.number",
              "individual.cpf",
            ],
          },
        },
        { status: 400 },
      ),
    );
    render(<CustomerOnboarding />);
    const cpf = await screen.findByLabelText("CPF");
    Object.defineProperty(cpf, "scrollIntoView", { value: scroll });
    await submitDraft();
    await waitFor(() => expect(cpf).toHaveFocus());
    expect(cpf).toHaveAttribute("aria-invalid", "true");
    expect(cpf).toHaveAccessibleDescription("Informe um CPF válido, com 11 dígitos.");
    expect(screen.getByLabelText("CEP")).toHaveAccessibleDescription(
      "Informe um CEP com 8 dígitos.",
    );
    expect(screen.getByLabelText("Telefone (DDD e número)")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Nome completo")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("Nome completo")).toHaveValue(syntheticIndividual.legal_name);
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
    fireEvent.change(cpf, { target: { value: "11111111111" } });
    expect(cpf).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("CEP")).toHaveAttribute("aria-invalid", "true");
  });
  it("shows required and numeric errors inline before submitting and keeps blank amounts blank", async () => {
    const fetcher = mockDraft(() => Response.json({ data: null }));
    render(<CustomerOnboarding />);
    const name = await screen.findByLabelText("Nome completo");
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Renda mensal em USD"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Volume mensal esperado em USD"), {
      target: { value: "-1" },
    });
    fireEvent.submit(name.closest("form")!);
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveAccessibleDescription("Preencha este campo.");
    expect(screen.getByLabelText("Renda mensal em USD")).toHaveValue(null);
    expect(screen.getByLabelText("Renda mensal em USD")).toHaveAccessibleDescription(
      "Preencha este campo.",
    );
    expect(screen.getByLabelText("Volume mensal esperado em USD")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });
  it("allows a corrected submission and exposes the next step without losing entered values", async () => {
    let attempts = 0;
    const fetcher = mockDraft(() =>
      ++attempts === 1
        ? Response.json(
            { error: { code: "VALIDATION_ERROR", fields: ["individual.cpf"] } },
            { status: 400 },
          )
        : Response.json({ data: { version: 2, individual: syntheticIndividual } }),
    );
    render(<CustomerOnboarding />);
    await submitDraft();
    await waitFor(() => expect(screen.getByLabelText("CPF")).toHaveFocus());
    fireEvent.change(screen.getByLabelText("CPF"), { target: { value: "529.982.247-25" } });
    expect(screen.queryByText("Corrija os campos destacados para continuar.")).toBeNull();
    await submitDraft();
    await screen.findByText(/Dados salvos · versão 2/);
    expect(
      screen.getByRole("button", { name: "Consultar termos para aceite" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nome completo")).toHaveValue(syntheticIndividual.legal_name);
    expect(screen.getByLabelText("CPF")).not.toHaveAttribute("aria-invalid");
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[1]?.[1]?.body))).toMatchObject({
      expected_version: 1,
      individual: { cpf: "529.982.247-25", monthly_income_usd: 400 },
    });
  });
  it.each([
    {
      code: "VALIDATION_ERROR",
      fields: [null, {}, "individual.unknown", "<script>value</script>"],
    },
    { code: "UNAVAILABLE", fields: ["individual.cpf"] },
    { code: "VALIDATION_ERROR", fields: "individual.cpf" },
  ])("keeps generic failures separate from field validation: $code", async (error) => {
    mockDraft(() => Response.json({ error }, { status: 400 }));
    render(<CustomerOnboarding />);
    await submitDraft();
    await screen.findByRole("alert");
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect(screen.getByLabelText("CPF")).toHaveValue(syntheticIndividual.cpf);
  });
});
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
    await screen.findByText(/Sobre a verificação no ambiente de testes/);
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
    expect(screen.getByText(/Este ambiente não permite operações reais/)).toBeInTheDocument();
  });
});
