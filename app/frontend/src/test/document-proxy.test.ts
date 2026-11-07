// @vitest-environment node
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  documentMethods,
  forwardDocument,
  DOCUMENT_PROXY_LIMIT,
} from "@/lib/peragus/document-proxy.server";
const path = "v1/me/onboarding/documents";
const url = new URL("https://backend.invalid/" + path);
const headers = {
  authorization: "Bearer synthetic.token",
  "content-type": "image/jpeg",
  "x-document-type": "identity_document",
  "x-document-side": "front",
  "idempotency-key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  cookie: "private=secret",
  "x-provider-key": "never",
};
afterEach(() => vi.restoreAllMocks());
describe("document bridge", () => {
  it("has exact routes and methods", () => {
    expect(documentMethods(path)).toEqual(["GET", "POST"]);
    expect(documentMethods(path + "/requirements")).toEqual(["GET"]);
    expect(documentMethods(path + "/../../admin")).toEqual([]);
    expect(documentMethods(path + "/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/refresh")).toEqual([
      "POST",
    ]);
  });
  it("forwards bounded binary bytes with only allowed headers, no cookies or redirects", async () => {
    let copied: number[] = [];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      copied = [...new Uint8Array(init?.body as Uint8Array)];
      return Response.json({ data: { state: "received" } });
    });
    const response = await forwardDocument(
      new Request("https://front.invalid/api/" + path, {
        method: "POST",
        headers,
        body: new Uint8Array([1, 2, 3]),
      }),
      url,
      path,
    );
    expect(response.status).toBe(200);
    expect(copied).toEqual([1, 2, 3]);
    const init = fetcher.mock.calls[0]?.[1];
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get("cookie")).toBeNull();
    expect(forwarded.get("x-provider-key")).toBeNull();
    expect(forwarded.get("authorization")).toBe(headers.authorization);
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects missing auth, over-limit streams, body on refresh, arbitrary method and query without fetch", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect((await forwardDocument(new Request("https://front.invalid"), url, path)).status).toBe(
      401,
    );
    expect(
      (
        await forwardDocument(
          new Request("https://front.invalid", {
            method: "POST",
            headers,
            body: new Uint8Array(DOCUMENT_PROXY_LIMIT + 1),
          }),
          url,
          path,
        )
      ).status,
    ).toBe(413);
    const refresh = path + "/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/refresh";
    expect(
      (
        await forwardDocument(
          new Request("https://front.invalid", { method: "POST", headers, body: "x" }),
          new URL("https://backend.invalid/" + refresh),
          refresh,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await forwardDocument(
          new Request("https://front.invalid", { method: "PATCH", headers }),
          url,
          path,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await forwardDocument(
          new Request("https://front.invalid", { headers }),
          new URL(url + "?customer_id=other"),
          path,
        )
      ).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports uncertain writes without exposing upstream details", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("secret signed URL"));
    const response = await forwardDocument(
      new Request("https://front.invalid", { method: "POST", headers, body: "x" }),
      url,
      path,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("DOCUMENT_OUTCOME_UNKNOWN");
  });
});
