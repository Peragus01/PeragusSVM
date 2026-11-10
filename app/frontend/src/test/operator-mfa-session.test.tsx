import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.hoisted(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://syntheticproject.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_synthetic");
});
import { CustomerSessionProvider, useCustomerSession } from "@/lib/peragus/customer-session";
const id = "11111111-1111-4111-8111-111111111111";
const tokens = (token: string) => ({
  access_token: token,
  refresh_token: "synthetic.refresh",
  expires_in: 3600,
});
const json = (body: unknown, status = 200) => Response.json(body, { status });
function Probe() {
  const session = useCustomerSession();
  return (
    <>
      <button
        onClick={() => {
          void session.login("operator@example.test", "synthetic-password").catch(() => {});
        }}
      >
        Login
      </button>
      <button
        onClick={() => {
          void session.verifyOperatorMfa("123456").catch(() => {});
        }}
      >
        MFA
      </button>
      <button
        onClick={() => {
          void session.enrollOperatorMfa().then((value) => {
            void session.verifyOperatorMfaEnrollment(value.factorId, "123456");
          });
        }}
      >
        Enroll MFA
      </button>
      <button onClick={session.logout}>Logout</button>
      <output>{session.accessToken ?? "no-session"}</output>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function login() {
  render(
    <CustomerSessionProvider>
      <Probe />
    </CustomerSessionProvider>,
  );
  fireEvent.click(screen.getByText("Login"));
  await screen.findByText("synthetic.aal1");
}
describe("operator MFA in existing memory-only session", () => {
  it("enrolls a TOTP factor, verifies it and promotes the in-memory session", async () => {
    // The raw GoTrue endpoint returns SVG. supabase-js normally converts this
    // to a data URL, but this application intentionally calls Auth directly.
    // Real QR SVGs with high error correction can exceed 100 kB.
    const qrCode =
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg">' +
      " ".repeat(110_000) +
      '<path d="M0 0h1v1z"/></svg>\n';
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(tokens("synthetic.aal1")))
      .mockResolvedValueOnce(
        json({ data: { user: { id, email: "operator@example.test" }, customer: null } }),
      )
      .mockResolvedValueOnce(json({ factors: [] }))
      .mockResolvedValueOnce(
        json({ id, type: "totp", totp: { qr_code: qrCode, secret: "JBSWY3DPEHPK3PXP" } }),
      )
      .mockResolvedValueOnce(json({ id: "enrollment-challenge" }))
      .mockResolvedValueOnce(json(tokens("synthetic.aal2")));
    await login();
    fireEvent.click(screen.getByText("Enroll MFA"));
    await screen.findByText("synthetic.aal2");
    expect(fetcher.mock.calls[2]![0]).toBe("https://syntheticproject.supabase.co/auth/v1/user");
    expect(fetcher.mock.calls[3]![0]).toBe("https://syntheticproject.supabase.co/auth/v1/factors");
    expect(JSON.parse(String(fetcher.mock.calls[3]![1]?.body))).toEqual({
      factor_type: "totp",
      friendly_name: "Peragus Operador",
    });
    expect(fetcher.mock.calls[4]![0]).toBe(
      `https://syntheticproject.supabase.co/auth/v1/factors/${id}/challenge`,
    );
    expect(JSON.parse(String(fetcher.mock.calls[5]![1]?.body))).toEqual({
      challenge_id: "enrollment-challenge",
      code: "123456",
    });
  });
  it("removes an incomplete TOTP factor before restarting enrollment", async () => {
    const staleId = "22222222-2222-4222-8222-222222222222";
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(tokens("synthetic.aal1")))
      .mockResolvedValueOnce(
        json({ data: { user: { id, email: "operator@example.test" }, customer: null } }),
      )
      .mockResolvedValueOnce(
        json({ factors: [{ id: staleId, factor_type: "totp", status: "unverified" }] }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json({
          id,
          type: "totp",
          totp: {
            qr_code: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            secret: "JBSWY3DPEHPK3PXP",
          },
        }),
      )
      .mockResolvedValueOnce(json({ id: "enrollment-challenge" }))
      .mockResolvedValueOnce(json(tokens("synthetic.aal2")));
    await login();
    fireEvent.click(screen.getByText("Enroll MFA"));
    await screen.findByText("synthetic.aal2");
    expect(fetcher.mock.calls[3]![0]).toBe(
      `https://syntheticproject.supabase.co/auth/v1/factors/${staleId}`,
    );
    expect(fetcher.mock.calls[3]![1]?.method).toBe("DELETE");
    expect(fetcher.mock.calls[3]![1]?.body).toBeUndefined();
  });
  it("gets verified factors, challenges, verifies and replaces the session token", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(tokens("synthetic.aal1")))
      .mockResolvedValueOnce(
        json({ data: { user: { id, email: "operator@example.test" }, customer: null } }),
      )
      .mockResolvedValueOnce(json({ factors: [{ id, factor_type: "totp", status: "verified" }] }))
      .mockResolvedValueOnce(json({ id: "synthetic-challenge" }))
      .mockResolvedValueOnce(json(tokens("synthetic.aal2")));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await login();
    expect(fetcher.mock.calls[0]![1]?.credentials).toBe("omit");
    expect(fetcher.mock.calls[1]![0]).toBe("/api/v1/me");
    expect(fetcher.mock.calls[1]![1]?.credentials).toBe("same-origin");
    fireEvent.click(screen.getByText("MFA"));
    await screen.findByText("synthetic.aal2");
    expect(fetcher.mock.calls[2]![0]).toBe("https://syntheticproject.supabase.co/auth/v1/user");
    expect(fetcher.mock.calls[2]![1]?.method).toBe("GET");
    expect(fetcher.mock.calls[2]![1]?.body).toBeUndefined();
    expect(fetcher.mock.calls[3]![0]).toBe(
      `https://syntheticproject.supabase.co/auth/v1/factors/${id}/challenge`,
    );
    expect(JSON.parse(String(fetcher.mock.calls[4]![1]?.body))).toEqual({
      challenge_id: "synthetic-challenge",
      code: "123456",
    });
    expect(new Headers(fetcher.mock.calls[4]![1]?.headers).get("authorization")).toBe(
      "Bearer synthetic.aal1",
    );
    expect(storage).not.toHaveBeenCalled();
  });
  it("does not replace tokens after rejected MFA", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(tokens("synthetic.aal1")))
      .mockResolvedValueOnce(
        json({ data: { user: { id, email: "operator@example.test" }, customer: null } }),
      )
      .mockResolvedValueOnce(json({ factors: [{ id, factor_type: "totp", status: "verified" }] }))
      .mockResolvedValueOnce(json({ id: "challenge" }))
      .mockResolvedValueOnce(json({ error: "PRIVATE_DETAILS" }, 400));
    await login();
    fireEvent.click(screen.getByText("MFA"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    expect(screen.getByText("synthetic.aal1")).toBeInTheDocument();
    expect(screen.queryByText("synthetic.aal2")).toBeNull();
  });
  it("does not resurrect a logged-out session when MFA resolves late", async () => {
    let resolve!: (response: Response) => void;
    const delayed = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(tokens("synthetic.aal1")))
      .mockResolvedValueOnce(
        json({ data: { user: { id, email: "operator@example.test" }, customer: null } }),
      )
      .mockResolvedValueOnce(json({ factors: [{ id, factor_type: "totp", status: "verified" }] }))
      .mockResolvedValueOnce(json({ id: "challenge" }))
      .mockReturnValueOnce(delayed)
      .mockResolvedValue(json({}));
    await login();
    fireEvent.click(screen.getByText("MFA"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    fireEvent.click(screen.getByText("Logout"));
    resolve(json(tokens("synthetic.aal2")));
    await screen.findByText("no-session");
    expect(screen.queryByText("synthetic.aal2")).toBeNull();
  });
});
