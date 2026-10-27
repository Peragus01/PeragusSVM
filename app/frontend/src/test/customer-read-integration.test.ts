import { afterEach, describe, it, expect, vi } from "vitest";
import { forwardCustomerRead, isCustomerReadPath } from "@/lib/peragus/customer-proxy.server";
import { getCustomerOperations, getCustomerWithdrawalResult } from "@/lib/peragus/customer-reads";

const id = "d3f9d95d-5719-48c8-9c30-a27fa0b27219";
const token = "synthetic.access.token";
const target = new URL("https://backend.example.test/v1/me/operations?limit=1");
const json = (body: unknown, status = 200) => Response.json(body, { status });
const request = (method = "GET", auth = true) =>
  new Request("https://app.example.test/api/v1/me/operations", {
    method,
    headers: auth
      ? { Authorization: `Bearer ${token}`, Cookie: "private-cookie=never-forward" }
      : {},
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("customer read bridge", () => {
  it("allows only exact customer read resources", () => {
    for (const path of ["v1/me", "v1/me/operations", `v1/me/withdrawal-requests/${id}/result`])
      expect(isCustomerReadPath(path)).toBe(true);
    for (const path of [
      "v1/admin/withdrawal-requests/" + id + "/execution",
      "v1/me/operations/delete",
      "v1/me/withdrawal-requests",
      "v1/me/../admin",
      "v1/me/withdrawal-requests/not-a-uuid/result",
    ])
      expect(isCustomerReadPath(path)).toBe(false);
  });
  it("forwards the bearer only, and never forwards cookies or response cookies", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"data":[]}', {
        headers: {
          "content-type": "application/json",
          "set-cookie": "secret=not-forwarded",
          "cache-control": "public,max-age=3600",
        },
      }),
    );
    const response = await forwardCustomerRead(request(), target);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(target.toString());
    expect(options).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(options?.headers).get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
  });
  it("blocks unauthenticated reads and POST before contacting backend", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect((await forwardCustomerRead(request("GET", false), target)).status).toBe(401);
    const blocked = await forwardCustomerRead(request("POST"), target);
    expect(blocked.status).toBe(405);
    expect(blocked.headers.get("allow")).toBe("GET");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves auth errors without caching or accepting an HTML challenge", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: { code: "INVALID_TOKEN" } }, 401))
      .mockResolvedValueOnce(
        new Response("<html>challenge</html>", { headers: { "content-type": "text/html" } }),
      );
    const denied = await forwardCustomerRead(request(), target);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    const html = await forwardCustomerRead(request(), target);
    expect(html.status).toBe(502);
    expect(await html.text()).not.toContain("challenge");
  });
  it("sanitizes connection failures without retrying", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("PRIVATE_UPSTREAM_DETAILS"));
    const response = await forwardCustomerRead(request(), target);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("PRIVATE_UPSTREAM_DETAILS");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("customer read client", () => {
  it("uses the same-origin proxy with an explicit bearer and cursor", async () => {
    const body = { data: [], meta: { has_more: false, next_cursor: null } };
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(body));
    expect(await getCustomerOperations(token, { limit: 1, cursor: "opaque_cursor" })).toEqual(body);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/me/operations?limit=1&cursor=opaque_cursor",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      }),
    );
  });
  it("retains unknown net/deducted amounts without assuming zero fees", async () => {
    const data = {
      withdrawal_request_id: id,
      environment: "test",
      real_money: false,
      onchain_delivery_verified: false,
      mainnet_execution: false,
      amounts: { gross_amount: "198.050000", net_amount: null, deducted_amount: null },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data }));
    expect((await getCustomerWithdrawalResult(token, id)).amounts).toEqual(data.amounts);
  });
  it("rejects invalid selectors before sending a token", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(getCustomerOperations(token, { limit: 51 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      getCustomerWithdrawalResult(token, "https://foreign.example"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(getCustomerOperations("")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps auth errors distinguishable without leaking messages or retrying", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        json({ error: { code: "AUTH_UNAVAILABLE", message: "PRIVATE_DETAILS" } }, 503),
      );
    const failure = await getCustomerOperations(token).catch((error) => error);
    expect(failure.code).toBe("AUTH_UNAVAILABLE");
    expect(failure.httpStatus).toBe(503);
    expect(failure.message).not.toContain("PRIVATE_DETAILS");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects misleading delivery markers and a mismatched withdrawal ID", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        json({
          data: [
            {
              id,
              environment: "test",
              real_money: false,
              onchain_delivery_verified: true,
              mainnet_execution: false,
            },
          ],
          meta: { has_more: false, next_cursor: null },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            withdrawal_request_id: "foreign",
            environment: "test",
            real_money: false,
            onchain_delivery_verified: false,
            mainnet_execution: false,
            amounts: { gross_amount: "1", net_amount: null, deducted_amount: null },
          },
        }),
      );
    await expect(getCustomerOperations(token)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(getCustomerWithdrawalResult(token, id)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
