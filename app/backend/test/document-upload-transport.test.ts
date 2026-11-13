import https from "node:https";
import { Resolver } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadDocumentBytes } from "../src/providers/document-upload.js";
afterEach(() => {
  vi.restoreAllMocks();
});
function transport(
  status = 200,
  aborted = false,
  origin = "https://storage.ozav.io",
) {
  const resolver = vi
    .spyOn(Resolver.prototype, "resolve4")
    .mockResolvedValue(["1.1.1.1"] as never);
  const end = vi.fn(),
    destroy = vi.fn();
  let options: Record<string, unknown> = {};
  const request = vi.spyOn(https, "request").mockImplementation(((
    url: URL,
    opts: Record<string, unknown>,
    callback: (res: EventEmitter) => void,
  ) => {
    expect(url.origin).toBe(origin);
    options = opts;
    const req = new EventEmitter();
    Object.assign(req, {
      end: (bytes: Buffer) => {
        end(bytes);
        queueMicrotask(() => {
          const res = new EventEmitter();
          Object.assign(res, { statusCode: status, complete: !aborted });
          callback(res);
          if (aborted) res.emit("aborted");
          else res.emit("end");
        });
      },
      destroy,
    });
    return req;
  }) as never);
  return { resolver, request, end, destroy, options: () => options };
}
describe("signed document PUT transport", () => {
  it("pins the checked IP, keeps TLS hostname and forwards only content headers", async () => {
    const t = transport();
    const bytes = Buffer.from("synthetic bytes");
    await uploadDocumentBytes(
      new URL("https://storage.ozav.io/upload?signature=synthetic"),
      bytes,
      "image/jpeg",
    );
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.end).toHaveBeenCalledWith(bytes);
    expect(t.options()).toMatchObject({
      method: "PUT",
      agent: false,
      family: 4,
      headers: { "Content-Type": "image/jpeg", "Content-Length": bytes.length },
    });
    expect(Object.keys(t.options().headers as object)).toHaveLength(2);
    const lookup = t.options().lookup as (
      host: string,
      opts: object,
      callback: (...args: unknown[]) => void,
    ) => void;
    const cb = vi.fn();
    lookup("storage.ozav.io", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "1.1.1.1", 4);
    expect(t.options()).not.toHaveProperty("rejectUnauthorized", false);
  });
  it("sends only a sandbox API key to the exact bound OZAV document path", async () => {
    const t = transport(200, false, "https://developers.ozav.io");
    const auth = {
      apiKey: "ozav_sk_test_synthetic123",
      customerId: "ozav_cus_1234567890123456",
      documentId: "ozav_doc_1234567890123456",
    };
    const url = new URL(
      `https://developers.ozav.io/v2/customers/${auth.customerId}/documents/${auth.documentId}/upload?upload_token=synthetic`,
    );
    await uploadDocumentBytes(
      url,
      Buffer.from("synthetic"),
      "image/jpeg",
      auth,
    );
    expect(t.options().headers).toEqual({
      "Content-Type": "image/jpeg",
      "Content-Length": 9,
      "X-API-Key": auth.apiKey,
    });
    expect(t.request).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    for (const [badUrl, badAuth] of [
      [
        new URL(
          `https://developers.ozav.io/v2/customers/${auth.customerId}/documents/ozav_doc_9999999999999999/upload?upload_token=synthetic`,
        ),
        auth,
      ],
      [url, { ...auth, apiKey: "ozav_sk_live_forbidden" }],
      [
        new URL(
          `https://developers.ozav.io/v2/customers/${auth.customerId}/documents/${auth.documentId}/upload`,
        ),
        auth,
      ],
    ] as const) {
      const next = transport(200, false, "https://developers.ozav.io");
      await expect(
        uploadDocumentBytes(badUrl, Buffer.from("x"), "image/jpeg", badAuth),
      ).rejects.toThrow("DOCUMENT_UPLOAD_ORIGIN_REFUSED");
      expect(next.request).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
  it("accepts the live key only when the configured money mode is live", async () => {
    const auth = {
      apiKey: "ozav_sk_live_synthetic123",
      customerId: "ozav_cus_1234567890123456",
      documentId: "ozav_doc_1234567890123456",
    };
    const url = new URL(
      `https://developers.ozav.io/v2/customers/${auth.customerId}/documents/${auth.documentId}/upload?upload_token=synthetic`,
    );
    const t = transport(200, false, "https://developers.ozav.io");
    await uploadDocumentBytes(url, Buffer.from("x"), "image/jpeg", { ...auth, mode: "live" });
    expect(t.request).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    const next = transport(200, false, "https://developers.ozav.io");
    await expect(
      uploadDocumentBytes(url, Buffer.from("x"), "image/jpeg", {
        ...auth,
        apiKey: "ozav_sk_test_synthetic123",
        mode: "live",
      }),
    ).rejects.toThrow("DOCUMENT_UPLOAD_ORIGIN_REFUSED");
    expect(next.request).not.toHaveBeenCalled();
  });
  it("never sends OZAV API keys to an external storage origin", async () => {
    const t = transport();
    await uploadDocumentBytes(
      new URL("https://storage.ozav.io/upload?signature=synthetic"),
      Buffer.from("x"),
      "image/jpeg",
      {
        apiKey: "ozav_sk_test_synthetic123",
        customerId: "ozav_cus_1234567890123456",
        documentId: "ozav_doc_1234567890123456",
      },
    );
    expect(t.options().headers).toEqual({
      "Content-Type": "image/jpeg",
      "Content-Length": 1,
    });
  });
  it("refuses private DNS answers without creating an HTTPS request", async () => {
    const t = transport();
    t.resolver.mockResolvedValueOnce(["169.254.169.254"] as never);
    await expect(
      uploadDocumentBytes(
        new URL("https://storage.ozav.io/upload"),
        Buffer.from("x"),
        "image/jpeg",
      ),
    ).rejects.toThrow("DOCUMENT_UPLOAD_ORIGIN_REFUSED");
    expect(t.request).not.toHaveBeenCalled();
  });
  it("classifies provider status and DNS failure without exposing request details", async () => {
    for (const [status, category] of [
      [302, "UPLOAD_HTTP_3XX"],
      [403, "UPLOAD_HTTP_4XX"],
      [503, "UPLOAD_HTTP_5XX"],
    ] as const) {
      const t = transport(status);
      await expect(
        uploadDocumentBytes(
          new URL("https://storage.ozav.io/secret?signature=private"),
          Buffer.from("x"),
          "image/jpeg",
        ),
      ).rejects.toMatchObject({
        code: "DOCUMENT_UPLOAD_UNCONFIRMED",
        diagnosticReason: category,
      });
      expect(t.request).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
    const t = transport();
    t.resolver.mockRejectedValueOnce(new Error("sensitive URL"));
    await expect(
      uploadDocumentBytes(
        new URL("https://storage.ozav.io/x"),
        Buffer.from("x"),
        "image/jpeg",
      ),
    ).rejects.toMatchObject({
      code: "DOCUMENT_UPLOAD_UNCONFIRMED",
      diagnosticReason: "UPLOAD_DNS_FAILURE",
    });
    expect(t.request).not.toHaveBeenCalled();
  });
  it("does not follow redirects or silently accept an interrupted response", async () => {
    for (const [status, aborted] of [
      [302, false],
      [200, true],
    ] as const) {
      const t = transport(status, aborted);
      await expect(
        uploadDocumentBytes(
          new URL("https://storage.ozav.io/upload"),
          Buffer.from("x"),
          "image/jpeg",
        ),
      ).rejects.toThrow("DOCUMENT_UPLOAD_UNCONFIRMED");
      expect(t.request).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });
});
