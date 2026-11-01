import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { OnboardingReceipt } from "@/components/peragus/onboarding-receipt";
describe("onboarding receipt", () => {
  it("does not promise email without server readiness or say pending capture is under review", () => {
    render(
      <OnboardingReceipt
        review={{ review_state: "pending_identity", email_notifications: { enabled: false } }}
      />,
    );
    expect(screen.getByText("Recebemos seu cadastro")).toBeVisible();
    expect(screen.getByText(/identidade ainda precisa ser concluída/)).toBeVisible();
    expect(screen.queryByText(/Avisaremos pelo e-mail/)).toBeNull();
  });
  it("shows waiting and notification only when backend confirms both", () => {
    render(
      <OnboardingReceipt
        review={{ review_state: "in_review", email_notifications: { enabled: true } }}
      />,
    );
    expect(screen.getByText("Seu cadastro está em análise")).toBeVisible();
    expect(screen.getByText(/Avisaremos pelo e-mail/)).toBeVisible();
  });
  it("discloses action required and never releases financial operations from an approval", () => {
    const view = render(
      <OnboardingReceipt
        review={{ review_state: "action_required", email_notifications: { enabled: true } }}
      />,
    );
    expect(screen.getByText("Precisamos de uma ação sua")).toBeVisible();
    view.rerender(
      <OnboardingReceipt
        review={{ review_state: "approved", email_notifications: { enabled: true } }}
      />,
    );
    expect(screen.getByText(/transferências reais continuam indisponíveis/)).toBeVisible();
  });
});
