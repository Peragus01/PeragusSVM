import { describe, expect, it } from "vitest";
import { OzavClient, OzavClientError, type OzavResponse, type OzavTransport } from "../src/providers/ozav-client.js";

const apiKey = "ozav_sk_test_fake_for_unit_tests";
const transfer = {
  id: "ozav_tr_test", object: "transfer", customer_id: "ozav_cus_test",
  quote_id: "ozav_q_test", status: "completed",
  source: { type: "fiat_payment", currency: "BRL", rail: "pix" },
  destination: { type: "wallet", wallet_id: "ozav_wal_test" },
  source_leg: { status: "completed" }, destination_leg: { status: "completed" },
  amounts: { source: { amount: "500", currency: "BRL" }, target: { amount: "89.55", currency: "USDT" } },
};

function setup(responses: (OzavResponse | Error)[]) {
  const paths: string[] = [];
  const delays: number[] = [];
  const transport: OzavTransport = async (path) => {
    paths.push(path);
    const response = responses.shift();
    if (!response) throw new Error("Unexpected call");
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    client: new OzavClient({ apiKey, transport, wait: async (ms) => { delays.push(ms); } }),
    paths, delays,
  };
}

describe("read-only OZAV sandbox client", () => {
  it("rejects live keys without exposing them", () => {
    expect(() => new OzavClient({ apiKey: "ozav_sk_live_secret" }))
      .toThrow("A sandbox OZAV key is required");
  });
  it("requires a test environment response", async () => {
    const { client } = setup([{ statusCode: 200, body: { environment: "live", scopes: [] } }]);
    await expect(client.getCapabilities()).rejects.toThrow("Invalid OZAV response");
  });
  it("validates capabilities", async () => {
    const { client } = setup([{ statusCode: 200, body: { environment: "test", scopes: ["events:read"] } }]);
    expect(await client.getCapabilities()).toEqual({ environment: "test", scopes: ["events:read"] });
  });
  it("keeps monetary amounts as decimal strings", async () => {
    const { client, paths } = setup([{ statusCode: 200, body: transfer }]);
    const result = await client.getTransfer(transfer.id);
    expect(result.amounts.target.amount).toBe("89.55");
    expect(result.sourceLegStatus).toBe("completed");
    expect(paths).toEqual(["/v2/transfers/ozav_tr_test"]);
  });
  it("rejects a transfer with a different identity", async () => {
    const { client } = setup([{ statusCode: 200, body: transfer }]);
    await expect(client.getTransfer("ozav_tr_other")).rejects.toThrow("Invalid OZAV response");
  });
  it("rejects malformed money amounts", async () => {
    const { client } = setup([{ statusCode: 200, body: { ...transfer, amounts: { ...transfer.amounts, target: { amount: 89.55, currency: "USDT" } } } }]);
    await expect(client.getTransfer(transfer.id)).rejects.toThrow("Invalid OZAV response");
  });
  it("does not retry authentication errors or include the body in errors", async () => {
    const { client, paths } = setup([{ statusCode: 401, body: { secret: apiKey } }]);
    await expect(client.getCapabilities()).rejects.toMatchObject({ message: "OZAV HTTP 401", retryable: false, statusCode: 401 });
    expect(paths).toHaveLength(1);
  });
  it("retries transient connection and rate-limit failures", async () => {
    const { client, paths, delays } = setup([
      new Error(`Transport secret: ${apiKey}`), { statusCode: 429, body: null },
      { statusCode: 200, body: transfer },
    ]);
    expect((await client.getTransfer(transfer.id)).id).toBe(transfer.id);
    expect(paths).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
  });
  it("limits retries and sanitizes transport errors", async () => {
    const { client, paths } = setup([new Error(apiKey), new Error(apiKey), new Error(apiKey)]);
    await expect(client.getCapabilities()).rejects.toThrow("OZAV connection failed");
    expect(paths).toHaveLength(3);
  });
  it("does not retry invalid JSON responses", async () => {
    const { client, paths } = setup([new OzavClientError("Invalid OZAV JSON response", false)]);
    await expect(client.getCapabilities()).rejects.toThrow("Invalid OZAV JSON response");
    expect(paths).toHaveLength(1);
  });
  it("uses the pagination cursor and preserves non-transfer events", async () => {
    const { client, paths } = setup([{ statusCode: 200, body: {
      data: [{ id: "ozav_evt_test", object: "event", type: "customer.updated", created_at: "2026-10-07T11:00:00Z", data: {} }],
      has_more: false, next_cursor: null,
    } }]);
    const result = await client.listEvents("cursor with spaces");
    expect(paths[0]).toBe("/v2/events?limit=100&starting_after=cursor+with+spaces");
    expect(result.data[0]?.transfer).toBeNull();
  });
  it("parses transfer event snapshots without claiming current state", async () => {
    const { client } = setup([{ statusCode: 200, body: {
      data: [{ id: "ozav_evt_test", object: "event", type: "transfer.completed", created_at: "2026-10-07T11:00:00Z", data: { transfer } }],
      has_more: false,
    } }]);
    expect((await client.listEvents()).data[0]?.transfer?.id).toBe(transfer.id);
  });
  it("rejects a truncated page without a next cursor", async () => {
    const { client } = setup([{ statusCode: 200, body: { data: [], has_more: true, next_cursor: null } }]);
    await expect(client.listEvents()).rejects.toThrow("Invalid OZAV response");
  });
});
