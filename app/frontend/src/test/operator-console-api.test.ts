import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardOperator, operatorMethods } from "@/lib/peragus/operator-proxy.server";
import { refundMethods } from "@/lib/peragus/refund-proxy.server";
import {
  completeRefund,
  decideOperationRefund,
  executeWithdrawal,
  getRuntimeControls,
  listNotifications,
  OperatorApiError,
  recordDailyReview,
  setRuntimeControl,
} from "@/lib/peragus/operator-console";
import {
  addDays,
  formatDuration,
  operatorErrorMessage,
  refundDeadline,
  saoPauloDay,
} from "@/lib/peragus/operator-labels";

const id = "d3f9d95d-5719-48c8-9c30-a27fa0b27219";
const requestId = "0b9e6f4e-5d1c-4a8b-9f3e-2c1d0a9b8c7d";
const token = "synthetic.aal2";
const body = (fetcher: ReturnType<typeof vi.spyOn>, index = 0) =>
  JSON.parse(String((fetcher.mock.calls[index]![1] as RequestInit).body));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("operator proxy allowlist", () => {
  it("opens exactly the operator console resources with their methods", () => {
    expect(operatorMethods("v1/admin/operator-status")).toEqual(["GET"]);
    expect(operatorMethods("v1/admin/runtime-controls")).toEqual(["GET", "PUT"]);
    expect(operatorMethods("v1/admin/daily-reviews")).toEqual(["POST"]);
    expect(operatorMethods("v1/admin/operational-alerts")).toEqual(["GET"]);
    expect(operatorMethods("v1/admin/operator-notifications")).toEqual(["GET"]);
    expect(operatorMethods("v1/admin/withdrawal-requests")).toEqual(["GET"]);
    expect(operatorMethods(`v1/admin/withdrawal-requests/${id}/approval`)).toEqual(["GET", "POST"]);
    expect(operatorMethods(`v1/admin/withdrawal-requests/${id}/execution`)).toEqual([
      "GET",
      "POST",
    ]);
    expect(operatorMethods(`v1/admin/withdrawal-requests/${id}/execution/reconcile`)).toEqual([
      "POST",
    ]);
    expect(operatorMethods(`v1/admin/withdrawal-requests/${id}/audit`)).toEqual(["GET"]);
    expect(refundMethods(`v1/admin/refund-requests/${id}/completion`)).toEqual(["POST"]);
    expect(refundMethods(`v1/admin/operations/${id}/refund-decision`)).toEqual(["POST"]);
    for (const path of [
      "v1/admin/withdrawal-requests/not-an-id/approval",
      `v1/admin/withdrawal-requests/${id}/execution/closure`,
      "v1/admin/customer-reconciliation",
      "v1/admin/runtime-controls/new_operations",
      "v1/admin/../admin/runtime-controls",
    ])
      expect(operatorMethods(path)).toEqual([]);
  });

  it("forwards a PUT body with the bearer only and refuses unauthenticated writes", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { key: "usdt_sends", enabled: false } }));
    const unauthenticated = await forwardOperator(
      new Request("https://app.example.test/api/v1/admin/runtime-controls", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      new URL("https://backend.example.test/v1/admin/runtime-controls"),
      "v1/admin/runtime-controls",
    );
    expect(unauthenticated.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await forwardOperator(
      new Request("https://app.example.test/api/v1/admin/runtime-controls", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Cookie: "private=never",
        },
        body: JSON.stringify({ key: "usdt_sends", enabled: false, reason: "Pausa" }),
      }),
      new URL("https://backend.example.test/v1/admin/runtime-controls"),
      "v1/admin/runtime-controls",
    );
    expect(response.status).toBe(200);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("cookie")).toBeNull();
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
    const wrong = await forwardOperator(
      new Request("https://app.example.test/api/v1/admin/daily-reviews", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
      new URL("https://backend.example.test/v1/admin/daily-reviews"),
      "v1/admin/daily-reviews",
    );
    expect(wrong.status).toBe(405);
  });
});

describe("operator console API", () => {
  it("toggles a runtime control with the mandatory reason", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          key: "usdt_sends",
          enabled: false,
          updated_by: id,
          updated_at: "2026-11-13T12:00:00.000Z",
          environment: "test",
          changed: true,
        },
      }),
    );
    await expect(setRuntimeControl(token, "usdt_sends", false, "   ")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
    const saved = await setRuntimeControl(token, "usdt_sends", false, " Pausa preventiva ");
    expect(saved.changed).toBe(true);
    expect(String(fetcher.mock.calls[0]![0])).toBe("/api/v1/admin/runtime-controls");
    expect((fetcher.mock.calls[0]![1] as RequestInit).method).toBe("PUT");
    expect(body(fetcher)).toEqual({
      key: "usdt_sends",
      enabled: false,
      reason: "Pausa preventiva",
    });
  });

  it("refuses runtime controls reported for another money mode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          environment: "live",
          controls: [
            {
              key: "new_operations",
              enabled: true,
              updated_by: null,
              updated_at: null,
              environment: "live",
            },
          ],
        },
      }),
    );
    await expect(getRuntimeControls(token)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("sends the mode-specific execution confirmation and surfaces the remaining delay", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: {
            code: "EXECUTION_TOO_EARLY",
            remaining_delay_seconds: 125,
            automatic_retry: false,
          },
        },
        { status: 409 },
      ),
    );
    const error = await executeWithdrawal(token, id, requestId, "test").catch((e) => e);
    expect(error).toBeInstanceOf(OperatorApiError);
    expect(error.details.remaining_delay_seconds).toBe(125);
    expect(operatorErrorMessage(error.code, error.details)).toContain("2 min 5 s");
    expect(body(fetcher)).toEqual({ request_id: requestId, confirmation: "SANDBOX_ONLY" });
    await executeWithdrawal(token, id, requestId, "live").catch(() => undefined);
    expect(body(fetcher, 1)).toEqual({ request_id: requestId, confirmation: "LIVE_USDT_SEND" });
  });

  it("posts the operator refund decision and the refund completion bodies", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ error: { code: "REFUND_ALREADY_PENDING" } }, { status: 409 }),
      );
    await decideOperationRefund(token, id, requestId, "Pix pago após o encerramento").catch(
      () => undefined,
    );
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      `/api/v1/admin/operations/${id}/refund-decision`,
    );
    expect(body(fetcher)).toEqual({
      request_id: requestId,
      reason: "Pix pago após o encerramento",
    });
    await completeRefund(token, id, requestId, "1000.00", " OZAV-ref-123 ").catch(() => undefined);
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `/api/v1/admin/refund-requests/${id}/completion`,
    );
    expect(body(fetcher, 1)).toEqual({
      request_id: requestId,
      amount_brl: "1000.00",
      reference: "OZAV-ref-123",
      confirmation: "MANUAL_REFUND_EXECUTED_EXTERNALLY",
    });
    await expect(
      completeRefund(token, id, requestId, "10,00", "OZAV-ref-123"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(completeRefund(token, id, requestId, "10.00", "short")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("records a daily review only for an ended São Paulo day", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          day: "2026-11-12",
          reviewed_by: id,
          reviewed_at: "2026-11-13T12:00:00.000Z",
          note: null,
          environment: "test",
          changed: true,
        },
      }),
    );
    const now = new Date("2026-11-13T15:00:00Z");
    await expect(recordDailyReview(token, "2026-11-13", undefined, now)).rejects.toMatchObject({
      code: "DAILY_REVIEW_DAY_NOT_ENDED",
    });
    expect(fetcher).not.toHaveBeenCalled();
    await recordDailyReview(token, "2026-11-12", "  ", now);
    expect(body(fetcher)).toEqual({ day: "2026-11-12" });
  });

  it("lists failed notifications without addresses", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          {
            id,
            kind: "stuck_operation",
            severity: "high",
            recipient_role: "trusted",
            status: "failed",
            last_error: "PROVIDER_REJECTED",
            purchase_id: null,
            created_at: "2026-11-13T12:00:00.000000Z",
            first_attempt_at: null,
            updated_at: "2026-11-13T12:00:00.000000Z",
            environment: "test",
          },
        ],
        meta: { environment: "test", limit: 100, status: "failed" },
      }),
    );
    const rows = await listNotifications(token, "failed");
    expect(rows[0]!.kind).toBe("stuck_operation");
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "/api/v1/admin/operator-notifications?status=failed",
    );
  });
});

describe("operator time helpers", () => {
  it("computes São Paulo calendar days", () => {
    expect(saoPauloDay(new Date("2026-11-13T02:30:00Z"))).toBe("2026-11-12");
    expect(saoPauloDay(new Date("2026-11-13T03:30:00Z"))).toBe("2026-11-13");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(formatDuration(3725)).toBe("1 h 2 min");
    expect(formatDuration(59)).toBe("59 s");
  });

  it("highlights the 24 h refund deadline at 12 h and 20 h", () => {
    const start = "2026-11-13T00:00:00.000Z";
    const at = (hours: number) => new Date(Date.parse(start) + hours * 3600_000);
    expect(refundDeadline(start, at(2)).level).toBe("ok");
    expect(refundDeadline(start, at(12)).level).toBe("warn");
    expect(refundDeadline(start, at(20)).level).toBe("danger");
    expect(refundDeadline(start, at(25)).level).toBe("overdue");
    expect(refundDeadline(start, at(2)).remainingSeconds).toBe(22 * 3600);
  });
});
