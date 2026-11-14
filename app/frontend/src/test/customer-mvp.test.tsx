import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "@/routeTree.gen";
import { RegistrationPage } from "@/routes/cadastro";
import { Route as DashboardRoute } from "@/routes/app.index";
import { PublicHome } from "@/routes/index";
import { CustomerPublicLayout } from "@/components/peragus/customer-ui";
import { environmentNotice } from "@/lib/peragus/customer-copy";
import {
  defaultSolanaRpcUrl,
  explorerAddress,
  explorerCluster,
  explorerTx,
  moneyMode,
  moneyNetwork,
  walletProofDomain,
} from "@/lib/peragus/config";
import {
  DeliveryEvidence,
  formatAmount,
  operationLabel,
  statusStyle,
} from "@/components/peragus/customer-operations";
import type { CustomerOperation } from "@/lib/peragus/customer-reads";
const session = vi.hoisted(() => ({ signup: vi.fn() }));
vi.mock("@/lib/peragus/customer-session", async (original) => ({
  ...(await original<typeof import("@/lib/peragus/customer-session")>()),
  signUpCustomer: session.signup,
  useCustomerSession: () => ({
    status: "unauthenticated",
    identity: null,
    accessToken: null,
    configured: true,
    reloadIdentity: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
beforeEach(() => {
  session.signup.mockReset();
  session.signup.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("customer frontend route structure", () => {
  const paths = [
    "/",
    "/login",
    "/cadastro",
    "/recuperar-senha",
    "/developers",
    "/settlements",
    "/app/",
    "/app/operacoes/",
    "/app/operacoes/11111111-1111-4111-8111-111111111111",
    "/app/comprar-usdt",
    "/app/carteira",
    "/app/minha-conta",
    "/app/auditoria",
    "/operador/estornos",
  ];
  for (const path of paths) {
    it("recognizes " + path, () => {
      const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
      expect(router.matchRoutes(path).at(-1)?.routeId).not.toBe(rootRouteId);
    });
  }
});
describe("financial evidence presentation", () => {
  const record = {
    id: "11111111-1111-4111-8111-111111111111",
    stage: "withdrawal",
    environment: "test",
    real_money: false,
    mainnet_execution: false,
    onchain_delivery_verified: false,
    withdrawal: { provider_completed: true, recovery_required: false },
  } as CustomerOperation;
  it("does not turn provider completion into onchain delivery", () => {
    expect(operationLabel(record)).toContain("entrega não confirmada");
    expect(statusStyle(record)).not.toContain("green");
  });
  it("does not print unknown net fees as zero", () => {
    expect(formatAmount(null, "USDT")).toBe("Não informado");
    expect(formatAmount(undefined, "BRL")).toBe("Não informado");
  });
});

describe("explorer links follow the money mode (Task 11)", () => {
  const signature = "5".repeat(88);
  it("uses mainnet-beta in live and devnet in test", () => {
    expect(explorerCluster("live")).toBe("mainnet-beta");
    expect(explorerCluster("test")).toBe("devnet");
    expect(explorerTx(signature, "live")).toBe(
      `https://explorer.solana.com/tx/${signature}?cluster=mainnet-beta`,
    );
    expect(explorerAddress("Addr", "test")).toBe(
      "https://explorer.solana.com/address/Addr?cluster=devnet",
    );
    expect(defaultSolanaRpcUrl("live")).toBe("https://api.mainnet-beta.solana.com");
    expect(defaultSolanaRpcUrl("test")).toBe("https://api.devnet.solana.com");
  });
  it("shows the net delivered amount and the backend explorer link once verified", () => {
    const url = `https://explorer.solana.com/tx/${signature}?cluster=mainnet-beta`;
    render(
      <DeliveryEvidence
        operation={
          {
            environment: "live",
            onchain_delivery_verified: true,
            delivered_target: { currency: "USDT", amount: "199.950000" },
            delivery_simulated: false,
            explorer_url: url,
          } as CustomerOperation
        }
      />,
    );
    expect(screen.getByText("199,95 USDT")).toBeTruthy();
    expect(screen.getByRole("link", { name: /explorador/i }).getAttribute("href")).toBe(url);
  });
  it("labels a simulated test send and shows no explorer link", () => {
    const { container } = render(
      <DeliveryEvidence
        operation={
          {
            environment: "test",
            onchain_delivery_verified: false,
            delivered_target: null,
            delivery_simulated: true,
            explorer_url: null,
          } as CustomerOperation
        }
      />,
    );
    expect(container.textContent).toMatch(/simulad/i);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("money mode drives customer-facing environment", () => {
  async function submitInvite(environment: string) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: { valid: true, environment, email_confirmation_required: true } }),
    );
    render(<RegistrationPage />);
    fireEvent.change(screen.getByLabelText("Código de convite"), {
      target: { value: "pginv_" + "a".repeat(43) },
    });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "client@example.test" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "synthetic-password" } });
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Criar minha conta" }));
  }
  it("signup accepts a live invitation when backend mode is live", async () => {
    vi.stubEnv("VITE_PERAGUS_MONEY_MODE", "live");
    await submitInvite("live");
    await waitFor(() =>
      expect(session.signup).toHaveBeenCalledWith("client@example.test", "synthetic-password"),
    );
  });
  it("signup refuses an invitation from another environment", async () => {
    vi.stubEnv("VITE_PERAGUS_MONEY_MODE", "live");
    await submitInvite("test");
    await screen.findByRole("alert");
    expect(session.signup).not.toHaveBeenCalled();
  });
  it("signup keeps accepting test invitations in test mode", async () => {
    await submitInvite("test");
    await waitFor(() => expect(session.signup).toHaveBeenCalled());
  });
  it("test banner hidden in live", () => {
    vi.stubEnv("VITE_PERAGUS_MONEY_MODE", "live");
    expect(moneyMode()).toBe("live");
    expect(environmentNotice("live")).toBeNull();
    const { container } = render(
      <CustomerPublicLayout>
        <p>conteúdo</p>
      </CustomerPublicLayout>,
    );
    expect(container.textContent).not.toMatch(/ambiente de testes/i);
  });
  it("test banner shown in test", () => {
    expect(moneyMode()).toBe("test");
    expect(environmentNotice("test")).toMatch(/Ambiente de testes/);
    const { container } = render(
      <CustomerPublicLayout>
        <p>conteúdo</p>
      </CustomerPublicLayout>,
    );
    expect(container.textContent).toMatch(/ambiente de testes/i);
  });
  it("maps the mode to its network and wallet proof domain", () => {
    expect(moneyNetwork("live")).toBe("solana:mainnet");
    expect(moneyNetwork("test")).toBe("solana:devnet");
    expect(walletProofDomain("live")).toBe("www.peragus.com.br");
    expect(walletProofDomain("test")).toBe("peragussvm-staging.up.railway.app");
  });
});

describe("test-environment copy follows the money mode", () => {
  const testCopy = /ambiente de testes|sem dinheiro real|devnet/i;
  const Dashboard = DashboardRoute.options.component as () => ReactNode;
  const screens: [string, () => ReactNode][] = [
    ["registration", () => <RegistrationPage />],
    ["dashboard", () => <Dashboard />],
    ["public home", () => <PublicHome />],
  ];
  for (const [name, Screen] of screens) {
    it(`${name} shows no test copy in live`, () => {
      vi.stubEnv("VITE_PERAGUS_MONEY_MODE", "live");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
      const { container } = render(<Screen />);
      expect(container.textContent).not.toMatch(testCopy);
    });
    it(`${name} shows the test banner in test`, () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
      const { container } = render(<Screen />);
      expect(container.textContent).toMatch(/ambiente de testes/i);
    });
  }
});
