import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import {
  ApiError,
  getOnramp,
  getSettlement,
  publicErrorCode,
  publicStatus,
  simulateSandboxPixPayment,
} from "@/lib/peragus/api";
import { SandboxPixQr, StatusTimeline } from "@/components/peragus/ControlRoom";
import { hasSafeSettlementWindow } from "@/lib/peragus/checkout";
import { WalletProvider } from "@/components/peragus/Wallet";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("API client", () => {
  it("maps error envelopes to neutral messages and keeps the code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json(404, { error: { code: "SETTLEMENT_NOT_FOUND", message: "raw backend text" } }),
    );
    const error = await getSettlement("/api", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("SETTLEMENT_NOT_FOUND");
    expect((error as ApiError).message).not.toContain("raw backend text");
  });
  it("uses neutral liquidity copy for unknown server errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json(502, { error: { code: "UPSTREAM_VENDOR_DOWN", message: "vendor X failed" } }),
    );
    const error = (await getSettlement("/api", "x").catch((e: unknown) => e)) as ApiError;
    expect(error.message).toBe("Liquidity rail temporarily unavailable.");
    expect(error.retryable).toBe(true);
  });
  it("reports network failure as an error, never success", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(getSettlement("/api", "x")).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });
  it("drops the payment code and QR payload from on-ramp data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json(200, {
        data: {
          stage: "ready",
          ready: true,
          pix: {
            intent_id: "i",
            br_code: "SECRET",
            qr_code_image: "QR",
            expires_at: "t",
            expired: false,
          },
        },
      }),
    );
    const { data } = await getOnramp("/api", "x");
    expect(JSON.stringify(data)).not.toContain("SECRET");
    expect(JSON.stringify(data)).not.toContain("QR");
  });

  it("confirms Pix only through the explicit sandbox endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json(202, {
        data: {
          settlement_id: "settlement-id",
          settlement_status: "awaiting_pix",
          accepted: true,
          reconciliation_scheduled: true,
        },
        meta: {
          idempotent_replay: false,
          environment: "sandbox",
        },
      }),
    );

    await simulateSandboxPixPayment("/api", "settlement-id");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/settlements/settlement-id/onramp/simulate-payment",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("Sandbox checkout", () => {
  it("requires a safe reserve window and renders a clearly fictitious QR", () => {
    const now = Date.parse("2026-10-11T20:00:00.000Z");
    expect(hasSafeSettlementWindow("2026-10-11T20:59:59.999Z", now)).toBe(false);
    expect(hasSafeSettlementWindow("2026-10-11T21:00:00.000Z", now)).toBe(true);

    render(<SandboxPixQr seed="settlement-id" />);
    expect(
      screen.getByRole("img", {
        name: /Fictitious sandbox Pix QR code/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("SANDBOX · NOT PAYABLE")).toBeInTheDocument();
  });
});

describe("Public status masking", () => {
  it("shows plain lifecycle statuses and masks provider-specific values", () => {
    expect(publicStatus("completed")).toBe("completed");
    expect(publicStatus("Pending")).toBe("pending");
    expect(publicStatus("acme_rail_transfer_ok")).toBe("—");
    expect(publicStatus(null)).toBe("—");
  });
  it("masks integration-specific backend error codes", () => {
    expect(publicErrorCode("SETTLEMENT_NOT_FOUND")).toBe("SETTLEMENT_NOT_FOUND");
    expect(publicErrorCode("ACME_PROVIDER_ERROR")).toBe("REQUEST_FAILED");
    expect(publicErrorCode("UPSTREAM_VENDOR_DOWN")).toBe("REQUEST_FAILED");
  });
});

describe("Request timeouts", () => {
  it("turns a hung request into a retryable timeout error", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("timeout", "TimeoutError")),
          ),
        ),
    );
    const pending = getSettlement("/api", "x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15001);
    const error = (await pending) as ApiError;
    vi.useRealTimers();
    expect(error.code).toBe("REQUEST_TIMEOUT");
    expect(error.retryable).toBe(true);
  });

  it("keeps the timeout active while the JSON response body is being read", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = init?.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener("abort", () =>
              reject(new DOMException("timeout", "TimeoutError")),
            ),
          ),
      } as Response);
    });
    const pending = getSettlement("/api", "x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15001);
    const error = (await pending) as ApiError;
    vi.useRealTimers();
    expect(error.code).toBe("REQUEST_TIMEOUT");
    expect(error.retryable).toBe(true);
  });
});

describe("Settlement state rendering", () => {
  it("marks earlier steps done and later steps pending at awaiting_pix", () => {
    render(<StatusTimeline status="awaiting_pix" />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveAttribute("data-state", "done");
    expect(items[1]).toHaveAttribute("data-state", "current");
    expect(items[7]).toHaveAttribute("data-state", "pending");
  });
  it("shows failed without marking any later step reached", () => {
    render(<StatusTimeline status="failed" />);
    expect(screen.getByText(/Settlement failed/)).toBeInTheDocument();
    for (const item of screen.getAllByRole("listitem"))
      expect(item).toHaveAttribute("data-state", "pending");
  });
});

describe("Wallet modal and disconnect", () => {
  it("portals the modal to document.body with scroll lock and closes on Escape", () => {
    render(
      <WalletProvider>
        <div />
      </WalletProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Connect Wallet/ }));
    const overlay = screen.getByTestId("wallet-overlay");
    expect(overlay.parentElement).toBe(document.body);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("clears the address immediately even if provider disconnect rejects", async () => {
    const address = Keypair.generate().publicKey.toBase58();
    const account = {
      address,
      publicKey: new Uint8Array(32),
      chains: ["solana:devnet"] as const,
      features: [],
    };
    const fake = {
      version: "1.0.0",
      name: "Test Wallet",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      chains: ["solana:devnet"],
      accounts: [account],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "standard:disconnect": {
          version: "1.0.0",
          disconnect: () => Promise.reject(new Error("provider failed")),
        },
      },
    } as unknown as Wallet;
    const unregister = getWallets().register(fake);
    render(
      <WalletProvider>
        <div />
      </WalletProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Connect Wallet/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Test Wallet/ }));
    });
    expect(screen.getByTestId("wallet-address")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect wallet" }));
    expect(screen.queryByTestId("wallet-address")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect Wallet/ })).toBeInTheDocument();
    unregister();
  });
});
