import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "@/routeTree.gen";
import {
  formatAmount,
  operationLabel,
  statusStyle,
} from "@/components/peragus/customer-operations";
import type { CustomerOperation } from "@/lib/peragus/customer-reads";

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
    expect(operationLabel(record)).toContain("entrega não verificada");
    expect(statusStyle(record)).not.toContain("green");
  });
  it("does not print unknown net fees as zero", () => {
    expect(formatAmount(null, "USDT")).toBe("Não informado");
    expect(formatAmount(undefined, "BRL")).toBe("Não informado");
  });
});
