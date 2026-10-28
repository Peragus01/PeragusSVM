import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { getOnboardingStatus, evidenceLabels } from "@/lib/peragus/onboarding-status";
import { OnboardingEvidence } from "@/components/peragus/onboarding-evidence";
import { forwardCustomerRead } from "@/lib/peragus/customer-proxy.server";
const id = "8877827c-3a86-4eeb-9545-465244a2c0a5";
const token = "synthetic.token";
vi.mock("@/lib/peragus/customer-session", () => ({
  useCustomerSession: () => ({
    accessToken: "synthetic.token",
    identity: {
      customer: { id: "8877827c-3a86-4eeb-9545-465244a2c0a5", verification_status: "draft" },
    },
  }),
}));
const data = {
  customer: { id },
  environment: "test",
  sandbox_only: true,
  source: "stored_observations",
  observation_freshness: "not_evaluated",
  operations_enabled: false,
  registration: { provider_status: "approved" },
  identity: { identity_outcome: "approved", checks: { aml_name_screening: "not_started" } },
  screening: { status: "completed", result: "clear" },
  pending_steps: [],
};
afterEach(() => vi.restoreAllMocks());
describe("stored onboarding evidence", () => {
  it("distinguishes local draft, identity approval and separate clear screening", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data }));
    render(<OnboardingEvidence />);
    expect(await screen.findByText("Aprovada (sandbox)")).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
    expect(screen.getByText("Concluído · sem apontamentos")).toBeInTheDocument();
    expect(screen.getByText(/atualidade não avaliada/)).toBeInTheDocument();
    expect(screen.getByText(/não autorizam operações/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/me/onboarding/status",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(data.identity.checks.aml_name_screening).toBe("not_started");
  });
  it("does not infer approvals when the read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { code: "UNAVAILABLE" } }, { status: 503 }),
    );
    render(<OnboardingEvidence />);
    expect(await screen.findByText(/Nenhuma aprovação foi inferida/)).toBeInTheDocument();
    expect(screen.queryByText("Aprovada (sandbox)")).toBeNull();
  });
  it.each([
    { ...data, customer: { id: "foreign" } },
    { ...data, environment: "production" },
    { ...data, operations_enabled: true },
    { ...data, identity: { identity_outcome: "invented" } },
    { ...data, screening: { status: 42, result: "clear" } },
    { ...data, pending_steps: [42] },
  ])("rejects mismatched or malformed evidence", async (invalid) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: invalid }));
    await expect(getOnboardingStatus(token, id)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("does not promote absent or partial checks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: { ...data, identity: null, screening: { status: "pending", result: "clear" } },
      }),
    );
    const labels = evidenceLabels(await getOnboardingStatus(token, id));
    expect(labels.identity).toBe("Não confirmada");
    expect(labels.screening).toContain("Não confirmado");
  });
  it("keeps onboarding proxy GET-only", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const response = await forwardCustomerRead(
      new Request("https://app.test/api/v1/me/onboarding/status", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      new URL("https://backend.test/v1/me/onboarding/status"),
    );
    expect(response.status).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
