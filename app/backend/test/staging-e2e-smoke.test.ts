import { describe, expect, it, vi } from "vitest";
import {
  assertLocalSafety,
  assertStagingSafe,
  assertTargetIsTest,
  SmokeGuardError,
} from "../scripts/lib/staging-smoke-guard.mjs";

const BASE = "https://staging.example.test";
const capabilities = (environment: unknown, network: unknown, status = 200) =>
  vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data: { environment, network } }),
  }));
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SmokeGuardError);
  return (error as SmokeGuardError).code;
};

describe("staging smoke guard", () => {
  it("accepts a clean staging environment", () => {
    expect(() => assertLocalSafety({ PATH: "x" })).not.toThrow();
    expect(() =>
      assertLocalSafety({ PERAGUS_DEPLOYMENT_ENV: "staging", OZAV_API_KEY: "ozav_sk_test_abc" }),
    ).not.toThrow();
  });

  it("refuses PERAGUS_DEPLOYMENT_ENV=production before any network call", async () => {
    const fetchImpl = vi.fn();
    const code = await refusal(
      assertStagingSafe({
        env: { PERAGUS_DEPLOYMENT_ENV: "production" },
        apiBase: BASE,
        customerToken: "t",
        fetchImpl,
      }),
    );
    expect(code).toBe("SMOKE_PRODUCTION_ENV");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses any env var holding an ozav_sk_live_ key without printing it", async () => {
    const fetchImpl = vi.fn();
    const secret = "ozav_sk_live_SUPERSECRETVALUE";
    const error = await assertStagingSafe({
      env: { SOME_RANDOM_KEY: secret },
      apiBase: BASE,
      customerToken: "t",
      fetchImpl,
    }).then(
      () => null,
      (e: unknown) => e as SmokeGuardError,
    );
    expect(error).toBeInstanceOf(SmokeGuardError);
    expect(error?.code).toBe("SMOKE_LIVE_KEY_PRESENT");
    expect(error?.message).not.toContain(secret);
    expect(error?.message).toContain("SOME_RANDOM_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an invalid or credential-bearing API base URL before any network call", async () => {
    const fetchImpl = vi.fn();
    for (const apiBase of [undefined, "", "not a url", "ftp://x.test", "http://staging.example.test", "https://u:p@x.test"]) {
      expect(await refusal(assertStagingSafe({ env: {}, apiBase, customerToken: "t", fetchImpl }))).toBe("SMOKE_API_BASE_INVALID");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows plain http only for localhost", async () => {
    const fetchImpl = capabilities("test", "solana:devnet");
    await expect(
      assertStagingSafe({ env: {}, apiBase: "http://localhost:3000", customerToken: "t", fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it("reads the capability endpoint with the customer token and accepts test + devnet", async () => {
    const fetchImpl = capabilities("test", "solana:devnet");
    await expect(
      assertStagingSafe({ env: {}, apiBase: `${BASE}/`, customerToken: "tok", fetchImpl }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${BASE}/v1/me/purchase-capabilities`);
    expect(init.headers.authorization).toBe("Bearer tok");
    expect((init as unknown as { redirect: string }).redirect).toBe("error");
  });

  it.each([
    ["live", "solana:mainnet"],
    ["live", "solana:devnet"],
    ["test", "solana:mainnet"],
    ["test", undefined],
    [undefined, "solana:devnet"],
  ])("refuses environment=%s network=%s", async (environment, network) => {
    expect(
      await refusal(assertTargetIsTest({ apiBase: BASE, customerToken: "t", fetchImpl: capabilities(environment, network) })),
    ).toBe("SMOKE_TARGET_NOT_TEST");
  });

  it("refuses when the target mode cannot be verified (non-200, network error, bad JSON)", async () => {
    expect(
      await refusal(assertTargetIsTest({ apiBase: BASE, customerToken: "t", fetchImpl: capabilities("test", "solana:devnet", 503) })),
    ).toBe("SMOKE_TARGET_UNVERIFIED");
    expect(
      await refusal(
        assertTargetIsTest({
          apiBase: BASE,
          customerToken: "t",
          fetchImpl: vi.fn(async () => {
            throw new Error("boom");
          }),
        }),
      ),
    ).toBe("SMOKE_TARGET_UNVERIFIED");
    expect(
      await refusal(
        assertTargetIsTest({
          apiBase: BASE,
          customerToken: "t",
          fetchImpl: vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error("bad json");
            },
          })),
        }),
      ),
    ).toBe("SMOKE_TARGET_UNVERIFIED");
  });

  it("refuses without a customer token", async () => {
    const fetchImpl = vi.fn();
    expect(await refusal(assertStagingSafe({ env: {}, apiBase: BASE, customerToken: "", fetchImpl }))).toBe("SMOKE_CUSTOMER_TOKEN_MISSING");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
