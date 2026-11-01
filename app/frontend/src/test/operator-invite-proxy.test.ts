import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardJourney, journeyMethods } from "@/lib/peragus/journey-proxy.server";

const id = "d3f9d95d-5719-48c8-9c30-a27fa0b27219";
const base = "https://backend.example.test";
const app = "https://app.example.test";
const bearer = "synthetic.access.token";
const request = (path: string, method: string, authenticated = true, body?: object) =>
  new Request(`${app}/api/${path}`, {
    method,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      Cookie: "private-cookie=must-not-forward",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("operator invite proxy allowlist", () => {
  it("allows only the intended methods and exact routes", () => {
    expect(journeyMethods("v1/admin/pilot-invites")).toEqual(["GET", "POST"]);
    expect(journeyMethods(`v1/admin/pilot-invites/${id}`)).toEqual(["GET"]);
    expect(journeyMethods(`v1/admin/pilot-invites/${id}/revoke`)).toEqual(["POST"]);
    for (const path of [
      "v1/admin/pilot-invites/delete",
      "v1/admin/pilot-invites/not-an-id",
      `v1/admin/pilot-invites/${id}/approve`,
      "v1/admin/withdrawal-requests",
      "v1/admin/pilot-invites/../admin",
    ])
      expect(journeyMethods(path)).toEqual([]);
  });

  it("rejects unauthenticated operator reads and writes without contacting the backend", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const method of ["GET", "POST"]) {
      const response = await forwardJourney(
        request("v1/admin/pilot-invites", method, false),
        new URL(`${base}/v1/admin/pilot-invites`),
        "v1/admin/pilot-invites",
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "AUTH_REQUIRED" } });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves bearer token, method and one-time response code but never forwards cookies", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { data: { id }, code: "pginv_one_time_code", meta: { idempotent_replay: false } },
          { status: 201, headers: { "set-cookie": "secret=never-forward" } },
        ),
      );
    const body = {
      request_id: id,
      target_email: "tester@example.test",
      expires_in_hours: 24,
      reason: "Operator authorized test invitation",
    };
    const response = await forwardJourney(
      request("v1/admin/pilot-invites", "POST", true, body),
      new URL(`${base}/v1/admin/pilot-invites`),
      "v1/admin/pilot-invites",
    );
    expect(response.status).toBe(201);
    expect((await response.json()).code).toBe("pginv_one_time_code");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("vary")).toBe("Authorization");
    const [target, options] = fetcher.mock.calls[0]!;
    expect(String(target)).toBe(`${base}/v1/admin/pilot-invites`);
    expect(options).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${bearer}`);
    expect(new Headers(options?.headers).get("cookie")).toBeNull();
    expect(JSON.parse(String(options?.body))).toEqual(body);
  });

  it("passes backend MFA denial through without bypassing authorization", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ error: { code: "WITHDRAWAL_OPERATOR_MFA_REQUIRED" } }, { status: 403 }),
      );
    const response = await forwardJourney(
      request("v1/admin/pilot-invites", "GET"),
      new URL(`${base}/v1/admin/pilot-invites`),
      "v1/admin/pilot-invites",
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "WITHDRAWAL_OPERATOR_MFA_REQUIRED" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
