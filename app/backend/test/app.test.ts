import { allAcceptedLegal } from "./helpers/legal-double.js";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("GET /health", () => {
  it("reports that the Peragus backend is running", async () => {
    const app = await buildApp();
    applications.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body).toMatchObject({
      status: "ok",
      service: "peragus-backend",
      version: "0.1.0",
    });

    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(body.uptimeSeconds).toEqual(expect.any(Number));
  });
});

describe("money mode drives customer-facing environment", () => {
  const customer = {
    id: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "owner-1",
    type: "pf" as const,
    displayName: "Cliente",
    verificationStatus: "draft" as const,
    suspended: false,
  };
  const customerAccess = { legal: allAcceptedLegal,
    authenticate: async () => ({ id: "owner-1", email: "c@example.test" }),
    customers: {
      findByOwner: async () => customer,
      createOrGet: async () => ({ customer, created: false }),
      ownsSettlement: async () => false,
    },
  };
  const headers = { authorization: "Bearer valid" };
  const pix = {
    simulatePayment: async () => {
      throw new Error("must not run");
    },
  } as never;
  const verification = {
    simulate: async () => {
      throw new Error("must not run");
    },
  } as never;

  it("live capabilities report mainnet and real_purchase true", async () => {
    const app = await buildApp({ customerAccess, moneyMode: "live" });
    applications.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/me/purchase-capabilities",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      environment: "live",
      network: "solana:mainnet",
      real_purchase: true,
    });
  });

  it("test capabilities keep devnet and no real purchase", async () => {
    const app = await buildApp({ customerAccess });
    applications.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/me/purchase-capabilities",
      headers,
    });
    expect(response.json().data).toMatchObject({
      environment: "test",
      network: "solana:devnet",
      real_purchase: false,
    });
  });

  it("simulate routes are not registered in live", async () => {
    const app = await buildApp({
      customerAccess,
      moneyMode: "live",
      customerSandboxPixService: pix,
      customerSandboxPixSimulationEnabled: true,
      customerVerificationService: verification,
      verificationSimulationEnabled: true,
      ozavSandboxCustomerService: {} as never,
    });
    applications.push(app);
    const id = "22222222-2222-4222-8222-222222222222";
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/me/sandbox-pix/${id}/simulate`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/me/onboarding/verification/simulate",
          headers,
          payload: { outcome: "approved" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/me/ozav-sandbox-customer",
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("simulate routes stay registered in test", async () => {
    const app = await buildApp({
      customerAccess,
      customerSandboxPixService: pix,
    });
    applications.push(app);
    const id = "22222222-2222-4222-8222-222222222222";
    const response = await app.inject({
      method: "POST",
      url: `/v1/me/sandbox-pix/${id}/simulate`,
      headers,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe(
      "CUSTOMER_SANDBOX_PIX_SIMULATION_DISABLED",
    );
  });

  it("verification simulate and sandbox-customer routes stay registered in test", async () => {
    const app = await buildApp({
      customerAccess,
      customerVerificationService: verification,
    });
    applications.push(app);
    const simulate = await app.inject({
      method: "POST",
      url: "/v1/me/onboarding/verification/simulate",
      headers,
      payload: { outcome: "approved" },
    });
    expect(simulate.statusCode).toBe(503);
    expect(simulate.json().error.code).toBe("VERIFICATION_SIMULATION_DISABLED");
    const sandboxCustomer = await app.inject({
      method: "GET",
      url: "/v1/me/ozav-sandbox-customer",
      headers,
    });
    expect(sandboxCustomer.statusCode).not.toBe(404);
    expect(sandboxCustomer.statusCode).toBe(503);
  });
});
