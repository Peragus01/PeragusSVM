import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PurchaseTimeline } from "@/components/peragus/purchase-timeline";
import { operationLabel } from "@/components/peragus/customer-operations";
import type { CustomerOperation } from "@/lib/peragus/customer-reads";

describe("truthful purchase progression", () => {
  it("never labels test processing or confirmation as real delivery", () => {
    render(<PurchaseTimeline paymentConfirmed deliveryVerified mainnetExecution testEnvironment />);
    expect(screen.queryByText("USDT entregue")).toBeNull();
    expect(screen.getByText("Entrega não confirmada")).toBeInTheDocument();
    expect(screen.getByText("Pagamento confirmado em teste")).toBeInTheDocument();
  });
  it("requires independent delivery and mainnet confirmation outside the test environment", () => {
    const view = render(
      <PurchaseTimeline
        paymentConfirmed
        deliveryVerified={false}
        mainnetExecution
        testEnvironment={false}
      />,
    );
    expect(screen.queryByText("USDT entregue")).toBeNull();
    view.rerender(
      <PurchaseTimeline
        paymentConfirmed
        deliveryVerified
        mainnetExecution={false}
        testEnvironment={false}
      />,
    );
    expect(screen.queryByText("USDT entregue")).toBeNull();
    view.rerender(
      <PurchaseTimeline
        paymentConfirmed
        deliveryVerified
        mainnetExecution
        testEnvironment={false}
      />,
    );
    expect(screen.getByText("USDT entregue")).toBeInTheDocument();
  });
  it("does not turn a provider completion into delivery or a payment confirmation", () => {
    const operation = {
      environment: "test",
      mainnet_execution: false,
      onchain_delivery_verified: false,
      withdrawal: { provider_completed: true },
    } as CustomerOperation;
    expect(operationLabel(operation)).toBe("Processamento finalizado · entrega não confirmada");
    render(
      <PurchaseTimeline
        paymentConfirmed={false}
        deliveryVerified={false}
        mainnetExecution={false}
        testEnvironment
      />,
    );
    expect(screen.getByText("Pagamento não confirmado")).toBeInTheDocument();
    expect(screen.queryByText("USDT entregue")).toBeNull();
  });
  it("keeps review and payment failure states visible instead of suggesting delivery", () => {
    const base = {
      environment: "test",
      mainnet_execution: false,
      onchain_delivery_verified: false,
    };
    expect(
      operationLabel({
        ...base,
        stage: "withdrawal",
        withdrawal: { provider_completed: true, recovery_required: true },
      } as CustomerOperation),
    ).toBe("Requer análise");
    expect(
      operationLabel({ ...base, stage: "pix", pix: { state: "expired" } } as CustomerOperation),
    ).toBe("Pagamento expirado");
    expect(
      operationLabel({
        ...base,
        stage: "withdrawal",
        withdrawal: { withdrawal_started: false },
      } as CustomerOperation),
    ).toBe("Aguardando análise");
  });
});
