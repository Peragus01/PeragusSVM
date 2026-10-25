import { describe, expect, it } from "vitest";
import {
  verificationCopy,
  onboardingState,
  parsePreviewBrl,
  formatPreviewBrl,
} from "@/lib/peragus/customer-ux";
import type { CustomerProfile } from "@/lib/peragus/customer-session";

const baseProfile: CustomerProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "pf",
  display_name: "Pessoa de Teste",
  verification_status: "draft",
  suspended: false,
  operations_enabled: false,
};

describe("guided onboarding", () => {
  it("uses server-verified customer status rather than claiming KYC completion", () => {
    const flow = onboardingState(true, baseProfile, null);
    expect(flow.completed).toBe(1);
    expect(flow.total).toBe(3);
    expect(flow.next?.key).toBe("identity");
    expect(flow.steps[1]?.complete).toBe(false);
  });

  it("counts a Devnet wallet connection only as a test connection", () => {
    const flow = onboardingState(true, baseProfile, "DevnetPublicKeyTest");
    expect(flow.completed).toBe(2);
    expect(flow.steps[2]?.detail).toContain("posse e rede principal não verificadas");
    expect(flow.steps[1]?.complete).toBe(false);
  });

  it("does not treat KYC approval as permission to make payments", () => {
    const approved = { ...baseProfile, verification_status: "approved" as const };
    expect(verificationCopy(approved).approved).toBe(true);
    const flow = onboardingState(true, approved, null);
    expect(flow.next?.key).toBe("wallet");
    expect(flow.completed).toBe(2);
  });

  it("shows access restrictions even if an account has approved verification", () => {
    const suspended = {
      ...baseProfile,
      verification_status: "approved" as const,
      suspended: true,
    };
    expect(verificationCopy(suspended).approved).toBe(false);
    expect(verificationCopy(suspended).tone).toBe("danger");
  });

  it.each(["draft", "submitted", "in_review", "action_required", "approved", "rejected"] as const)(
    "shows a human-readable title for %s",
    (verification_status) => {
      const status = verificationCopy({ ...baseProfile, verification_status });
      expect(status.title.length).toBeGreaterThan(12);
      expect(status.title).not.toContain("_");
    },
  );

  it("does not fabricate a created account when the profile is absent", () => {
    expect(verificationCopy(null).approved).toBe(false);
    expect(onboardingState(true, null, null).completed).toBe(1);
  });
});

describe("BRL preview amount", () => {
  it("accepts Brazilian decimal formatting and sample amounts", () => {
    expect(parsePreviewBrl("250,00")).toBe(250);
    expect(parsePreviewBrl("0,01")).toBe(0.01);
    expect(parsePreviewBrl("100.50")).toBe(100.5);
    expect(formatPreviewBrl(250)).toContain("250,00");
  });

  it.each(["", "0", "-2", "0,00", "1,234", "1e5", "1.000,00", "abc", "1000000000"])(
    "rejects invalid or ambiguous amount %s",
    (input) => {
      expect(parsePreviewBrl(input)).toBeNull();
    },
  );
});
