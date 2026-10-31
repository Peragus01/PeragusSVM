import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { forwardRefund, refundMethods } from "@/lib/peragus/refund-proxy.server";
import {
  getRefund,
  requestRefund,
  listRefunds,
  decideRefund,
  refundLabels,
} from "@/lib/peragus/refunds";
import { CustomerRefund } from "@/components/peragus/customer-refund";
const purchase = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const token = "synthetic.access.token";
const reason = "Solicitacao sandbox para analise manual.";
const path = `v1/me/operations/${purchase}/refund-request`;
const data = {
  id,
  purchase_intent_id: purchase,
  pix_id: id,
  request_id: id,
  state: "pending_review",
  reason,
  requested_amount: { currency: "BRL", amount: "1000.00" },
  created_at: "2026-10-24T12:00:00Z",
  decision_recorded_at: null,
  returned_amount: null,
  partial_refund: null,
  refund_recorded_at: null,
  environment: "test",
  record_only: true,
  refund_execution_automated: false,
  provider_verified: false,
  original_transfer_cancelled: false,
};
const operator = {
  ...data,
  customer_id: id,
  decision: null,
  completion: null,
  withdrawal_context: {
    started: true,
    provider_state: "completed",
    requires_manual_funds_review: true,
  },
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const req = (method = "POST", body = "{}", auth = true) =>
  new Request("https://app.test/api/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}`, Cookie: "private=hidden" } : {}),
    },
    ...(method === "POST" ? { body } : {}),
  });
const target = new URL("https://backend.test/" + path);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("refund bridge", () => {
  it("exposes exact refund resources and keeps completion/execution closed", () => {
    expect(refundMethods(path)).toEqual(["GET", "POST"]);
    expect(refundMethods("v1/admin/refund-requests")).toEqual(["GET"]);
    expect(refundMethods(`v1/admin/refund-requests/${id}/decision`)).toEqual(["POST"]);
    for (const p of [
      `v1/admin/refund-requests/${id}/completion`,
      `v1/admin/withdrawal-requests/${id}/execution`,
      path + "/extra",
      "v1/admin/anything",
    ])
      expect(refundMethods(p)).toEqual([]);
  });
  it("forwards bearer once without cookies, caching or redirects", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data }), {
        status: 201,
        headers: { "Content-Type": "application/json", "Set-Cookie": "secret=hidden" },
      }),
    );
    const response = await forwardRefund(req(), target, path);
    expect(response.status).toBe(201);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const options = fetcher.mock.calls[0]![1]!;
    expect(options).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(options.headers).get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
  });
  it("blocks missing auth, invalid method, oversized stream and malformed JSON before fetch", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect((await forwardRefund(req("POST", "{}", false), target, path)).status).toBe(401);
    expect((await forwardRefund(req(), target, "v1/admin/refund-requests")).status).toBe(405);
    expect((await forwardRefund(req("POST", "x".repeat(4097)), target, path)).status).toBe(413);
    expect((await forwardRefund(req("POST", "{"), target, path)).status).toBe(400);
    expect(
      (await forwardRefund(req(), target, `v1/admin/refund-requests/${id}/completion`)).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks insecure remote target before passing token", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect((await forwardRefund(req(), new URL("http://backend.test/" + path), path)).status).toBe(
      502,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sanitizes ambiguous errors without retrying", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("PRIVATE_SECRET"));
    const response = await forwardRefund(req(), target, path);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("PRIVATE_SECRET");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves disabled response and authenticated GET privacy", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: { code: "MANUAL_REFUNDS_DISABLED" } }, 503))
      .mockResolvedValueOnce(json({ data }));
    expect((await forwardRefund(req(), target, path)).status).toBe(503);
    const response = await forwardRefund(req("GET"), target, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe("Authorization");
  });
});
describe("refund client", () => {
  it("keeps approval distinct from an unknown return", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: { ...data, state: "approved" } }));
    const result = await getRefund(token, purchase);
    expect(vi.mocked(fetch).mock.calls[0]![1]?.credentials).toBe("same-origin");
    expect(result.returned_amount).toBeNull();
    expect(refundLabels[result.state]).toContain("pendente");
  });
  it("rejects customer leakage and fabricated return evidence", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ data: operator }))
      .mockResolvedValueOnce(json({ data: { ...data, state: "refund_recorded" } }));
    await expect(getRefund(token, purchase)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(getRefund(token, purchase)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("rejects invalid IDs, reason and missing token before fetch", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(getRefund(token, "invalid")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(requestRefund(token, purchase, id, "tiny")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(getRefund("", purchase)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends explicit manual decision confirmation and retains funds review", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ data: { ...operator, state: "approved" } }));
    expect(
      (await decideRefund(token, id, purchase, "approved", reason)).withdrawal_context
        .requires_manual_funds_review,
    ).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      request_id: purchase,
      confirmation: "MANUAL_REVIEW_COMPLETED",
    });
  });
  it("uses cursor pagination without customer selectors", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ data: [operator], meta: { has_more: false, next_cursor: null } }));
    expect((await listRefunds(token, "opaque_cursor")).data).toHaveLength(1);
    expect(fetcher.mock.calls[0]![0]).toBe(
      "/api/v1/admin/refund-requests?state=all&limit=20&cursor=opaque_cursor",
    );
  });
});
describe("customer refund UI", () => {
  it("shows approved pending return and no second request form", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: { ...data, state: "approved" } }));
    render(<CustomerRefund accessToken={token} purchaseId={purchase} hasPix />);
    expect(await screen.findByText("Aprovado · devolução pendente")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Solicitar análise de estorno" })).toBeNull();
  });
  it("retains one key/body after an uncertain write", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: { code: "REFUND_REQUEST_NOT_FOUND" } }, 404))
      .mockRejectedValueOnce(Error("timeout"))
      .mockResolvedValueOnce(json({ data }));
    render(<CustomerRefund accessToken={token} purchaseId={purchase} hasPix />);
    const input = await screen.findByLabelText("Motivo do pedido");
    fireEvent.change(input, { target: { value: reason } });
    fireEvent.click(screen.getByRole("button", { name: "Solicitar análise de estorno" }));
    const retry = await screen.findByRole("button", { name: "Repetir mesmo pedido" });
    await waitFor(() => expect(retry).not.toBeDisabled());
    expect(input).toBeDisabled();
    fireEvent.click(retry);
    await screen.findByText("Em análise");
    expect(fetcher.mock.calls[1]![1]?.body).toBe(fetcher.mock.calls[2]![1]?.body);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("hides request form if initial read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: { code: "AUTH_UNAVAILABLE" } }, 503),
    );
    render(<CustomerRefund accessToken={token} purchaseId={purchase} hasPix />);
    await screen.findByText(/Não foi possível confirmar o resultado/);
    expect(screen.queryByLabelText("Motivo do pedido")).toBeNull();
  });
});
