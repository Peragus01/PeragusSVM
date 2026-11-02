import https from "node:https";
import { Resolver } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadDocumentBytes } from "../src/providers/document-upload.js";
afterEach(() => {
  vi.restoreAllMocks();
});
function transport(status = 200, aborted = false) {
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
    expect(url.origin).toBe("https://storage.ozav.io");
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
