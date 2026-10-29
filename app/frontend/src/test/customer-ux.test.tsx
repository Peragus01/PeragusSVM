import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { PublicHome } from "@/routes/index";
import { LoginPage } from "@/routes/login";
import { CustomerOperations } from "@/routes/app.operacoes.index";
import { CustomerLayout } from "@/components/peragus/customer-ui";
const state = vi.hoisted(() => ({
  status: "unauthenticated",
  configured: true,
  login: vi.fn(),
  logout: vi.fn(),
  navigate: vi.fn(),
  more: vi.fn(),
  records: [
    {
      id: "one",
      created_at: "2026-10-28T12:00:00Z",
      stage: "purchase_recorded",
      source: { amount: "1000.00" },
      estimated_target: { amount: "186.590000" },
      environment: "test",
    },
    {
      id: "two",
      created_at: "2026-10-20T12:00:00Z",
      stage: "pix",
      source: { amount: "500.00" },
      estimated_target: { amount: "90.00" },
      environment: "test",
    },
  ],
}));
vi.mock("@/lib/peragus/customer-session", () => ({
  useCustomerSession: () => ({
    status: state.status,
    configured: state.configured,
    login: state.login,
    logout: state.logout,
    identity: { user: { id: "synthetic", email: "client@example.test" }, customer: null },
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    children,
    onClick,
    className,
  }: {
    to: string;
    children: ReactNode;
    onClick?: () => void;
    className?: string;
  }) => (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  ),
  Outlet: () => <div>Conteúdo autenticado</div>,
  useNavigate: () => state.navigate,
}));
vi.mock("@/components/peragus/customer-operations", async (original) => ({
  ...(await original<typeof import("@/components/peragus/customer-operations")>()),
  useOperations: () => ({
    data: { data: state.records, meta: { has_more: true, next_cursor: "next" } },
    state: "ready",
    more: state.more,
    retry: vi.fn(),
  }),
}));
beforeEach(() => {
  state.status = "unauthenticated";
  state.configured = true;
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());
describe("customer UX", () => {
  it("exposes login on the public home without polling health or mounting the technical control room", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    render(<PublicHome />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Menos fronteiras");
    expect(screen.getByRole("link", { name: "Acessar minha conta" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.queryByText(/Backend online|Checking backend|RPC unavailable/)).toBeNull();
    expect(screen.getByText(/Operações reais ainda não disponíveis/)).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps login, password visibility and invitation access usable", async () => {
    state.login.mockResolvedValue(undefined);
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "client@example.test" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Mostrar senha" }));
    expect(screen.getByLabelText("Senha")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Ocultar senha" }));
    expect(screen.getByLabelText("Senha")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Entrar na Peragus" }));
    await waitFor(() =>
      expect(state.login).toHaveBeenCalledWith("client@example.test", "synthetic-password"),
    );
    expect(screen.getByRole("link", { name: "Tenho um convite" })).toHaveAttribute(
      "href",
      "/cadastro",
    );
  });
  it("applies filters only to loaded operations, clears filters and keeps pagination available", () => {
    render(<CustomerOperations />);
    expect(screen.getAllByRole("link", { name: "Abrir" })).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Etapa"), { target: { value: "pix" } });
    expect(screen.getAllByRole("link", { name: "Abrir" })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("De"), { target: { value: "2026-10-25" } });
    expect(screen.getByText("Nenhuma operação neste filtro")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(state.more).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(screen.getAllByRole("link", { name: "Abrir" })).toHaveLength(2);
  });
  it("rejects an inverted date range without showing matching results", () => {
    render(<CustomerOperations />);
    fireEvent.change(screen.getByLabelText("De"), { target: { value: "2026-10-29" } });
    fireEvent.change(screen.getByLabelText("Até"), { target: { value: "2026-10-20" } });
    expect(screen.getByText(/A data inicial deve ser anterior/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Abrir" })).toBeNull();
  });
  it("retains the authentication guard and clears the session through logout", () => {
    const view = render(<CustomerLayout />);
    expect(screen.queryByText("Conteúdo autenticado")).toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({ to: "/login", replace: true });
    state.status = "authenticated";
    view.rerender(<CustomerLayout />);
    expect(screen.getByText("Conteúdo autenticado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir navegação" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".customer-sidebar")).not.toHaveClass("is-open");
    fireEvent.click(screen.getByRole("button", { name: "Encerrar sessão" }));
    expect(state.logout).toHaveBeenCalledOnce();
  });
});
