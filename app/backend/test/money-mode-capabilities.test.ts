import { describe, expect, it } from "vitest";
import type { MoneyMode } from "../src/config/money-environment.js";
import { OzavClient } from "../src/providers/ozav-client.js";
import { CustomerVerificationService } from "../src/onboarding/customer-verification-service.js";
import { CustomerScreeningService } from "../src/onboarding/customer-screening-service.js";
import { CustomerSubmissionService, RegistrationSnapshotService } from "../src/onboarding/customer-submission-service.js";
import { CustomerTermsService } from "../src/onboarding/customer-terms-service.js";
import { CustomerDocumentService } from "../src/onboarding/customer-documents.js";
import { CustomerQuoteService } from "../src/quotes/customer-quotes.js";
import { CustomerSandboxPixService } from "../src/purchases/customer-sandbox-pix.js";

const customerId = "11111111-1111-4111-8111-111111111111";
const linked = {
  state: "linked",
  providerId: "ozav_cus_1234567890123456",
  verificationMode: "full",
  snapshotVersion: 0,
};
/** Any call other than the capabilities read proves the capability gate was passed. */
const provider = (environment: MoneyMode) =>
  new Proxy(
    {},
    {
      get: (_t, name) =>
        name === "getCustomerCapabilities"
          ? async () => ({
              environment,
              entitlements: ["customers", "compliance", "liquidity", "custody"],
              scopes: [
                "customers:read",
                "customers:write",
                "verifications:read",
                "verifications:write",
                "screenings:read",
                "screenings:write",
                "quotes:write",
                "wallets:read",
                "transfers:read",
                "transfers:write",
              ],
            })
          : async () => {
              throw new Error("GATE_PASSED");
            },
    },
  ) as never;
const fake = (values: Record<string, unknown>) =>
  new Proxy(
    {},
    { get: (_t, name) => async () => values[name as string] ?? null },
  ) as never;
const submissions = fake({ find: linked });

type Case = [string, string, (mode: MoneyMode, caps: MoneyMode) => Promise<unknown>];
const cases: Case[] = [
  ["verification", "VERIFICATION_CAPABILITY_REQUIRED", (mode, caps) =>
    new CustomerVerificationService(
      fake({ find: { verificationId: "v", providerCustomerId: linked.providerId } }),
      submissions,
      provider(caps),
      mode,
    ).refresh(customerId)],
  ["screening", "SCREENING_CAPABILITY_REQUIRED", (mode, caps) =>
    new CustomerScreeningService(fake({}), submissions, provider(caps), mode).start(customerId)],
  ["registration snapshot", "ONBOARDING_CAPABILITY_REQUIRED", (mode, caps) =>
    new RegistrationSnapshotService(submissions, provider(caps), mode).refresh(customerId)],
  ["submission refresh", "ONBOARDING_CAPABILITY_REQUIRED", (mode, caps) =>
    new CustomerSubmissionService(submissions, {} as never, fake({}), fake({}), provider(caps), mode).refresh(customerId)],
  ["terms", "TERMS_CAPABILITY_REQUIRED", (mode, caps) =>
    new CustomerTermsService(
      fake({ reserve: { record: { idempotencyKey: "k" }, claimed: true } }),
      {} as never,
      provider(caps),
      fake({}),
      () => new Date(),
      mode,
    ).start(customerId)],
  ["documents", "DOCUMENT_CAPABILITY_REQUIRED", (mode, caps) =>
    new CustomerDocumentService(fake({}), submissions, provider(caps), new Set(), async () => {}, () => {}, mode)
      .requirements(customerId)],
  ["quotes", "QUOTE_CAPABILITY_REQUIRED", (mode, caps) =>
    new CustomerQuoteService(fake({}), submissions, provider(caps), mode).create(
      customerId,
      "22222222-2222-4222-8222-222222222222",
      "1000.00",
    )],
  ["pix", "PIX_CAPABILITY_REQUIRED", (mode, caps) =>
    new CustomerSandboxPixService(fake({ context: { providerCustomerId: linked.providerId } }), provider(caps), mode).create(
      customerId,
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    )],
];

describe("service capability gates follow the configured money mode", () => {
  for (const [name, code, run] of cases) {
    it(`${name}: live mode accepts live provider capabilities`, async () => {
      await expect(run("live", "live")).rejects.toThrow("GATE_PASSED");
    });
    it(`${name}: live mode refuses test provider capabilities`, async () => {
      await expect(run("live", "test")).rejects.toThrow(code);
    });
    it(`${name}: test mode refuses live provider capabilities`, async () => {
      await expect(run("test", "live")).rejects.toThrow(code);
    });
  }
});

describe("OZAV customer capabilities follow the client mode", () => {
  const client = (mode: MoneyMode, environment: string) =>
    new OzavClient({
      apiKey: `ozav_sk_${mode}_synthetic`,
      mode,
      attempts: 1,
      transport: async () => ({
        statusCode: 200,
        body: { environment, entitlements: ["customers"], scopes: ["customers:read"] },
      }),
    });
  it("returns live capabilities for a live client", async () => {
    await expect(client("live", "live").getCustomerCapabilities()).resolves.toMatchObject({ environment: "live" });
  });
  it("refuses capabilities from the other environment", async () => {
    await expect(client("live", "test").getCustomerCapabilities()).rejects.toThrow();
    await expect(client("test", "live").getCustomerCapabilities()).rejects.toThrow();
  });
});
