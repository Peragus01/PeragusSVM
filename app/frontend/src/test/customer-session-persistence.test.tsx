import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.hoisted(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://syntheticproject.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_synthetic");
});
import { CustomerSessionProvider, useCustomerSession } from "@/lib/peragus/customer-session";

const KEY = "peragus.session";
const id = "11111111-1111-4111-8111-111111111111";
const identity = { data: { user: { id, email: "user@example.test" }, customer: null } };
const tokenBody = (access: string, refresh = "synthetic.refresh.2") => ({
  access_token: access,
  refresh_token: refresh,
  expires_in: 3600,
});
const json = (body: unknown, status = 200) => Response.json(body, { status });
const stored = (over: Record<string, unknown> = {}) => ({
  access_token: "stored.access",
  refresh_token: "stored.refresh",
  expires_at: Date.now() + 3_600_000,
  user: { id, email: "user@example.test" },
  ...over,
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => handler(String(input), init));
}
const bearer = (init?: RequestInit) => new Headers(init?.headers).get("authorization");
const tokenCalls = (fetcher: ReturnType<typeof mockFetch>, grant: string) =>
  fetcher.mock.calls.filter(([url]) => String(url).includes(`token?grant_type=${grant}`));

let refreshApi: ReturnType<typeof useCustomerSession> | null = null;
function Probe() {
  const session = useCustomerSession();
  refreshApi = session;
  return (
    <>
      <button
        onClick={() => {
          void session.login("user@example.test", "synthetic-password").catch(() => {});
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
      <button onClick={session.logout}>Logout</button>
      <output data-testid="status">{session.status}</output>
      <output data-testid="token">{session.accessToken ?? "no-session"}</output>
    </>
  );
}
const mount = () =>
  render(
    <CustomerSessionProvider>
      <Probe />
    </CustomerSessionProvider>,
  );

beforeEach(() => {
  window.sessionStorage.clear();
  refreshApi = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("persistent per-tab session", () => {
  it("session survives reload", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("grant_type=password"))
        return json(tokenBody("login.access", "login.refresh"));
      if (url === "/api/v1/me") return json(identity);
      return json({}, 404);
    });
    const first = mount();
    fireEvent.click(screen.getByText("Login"));
    await screen.findByText("login.access");
    const raw = JSON.parse(window.sessionStorage.getItem(KEY)!);
    expect(raw.access_token).toBe("login.access");
    expect(raw.refresh_token).toBe("login.refresh");
    expect(raw.user).toEqual({ id, email: "user@example.test" });
    expect(JSON.stringify(raw)).not.toContain("123456");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    first.unmount(); // simulated reload: new provider, same tab storage
    fetcher.mockClear();
    mount();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    expect(screen.getByTestId("token").textContent).toBe("login.access");
    expect(tokenCalls(fetcher, "password")).toHaveLength(0);
    expect(tokenCalls(fetcher, "refresh_token")).toHaveLength(0);
    const me = fetcher.mock.calls.find(([url]) => url === "/api/v1/me")!;
    expect(bearer(me[1])).toBe("Bearer login.access");
  });

  it("expired access token is refreshed once", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(stored({ expires_at: Date.now() - 1000 })));
    const fetcher = mockFetch(async (url, init) => {
      if (url.includes("grant_type=refresh_token")) {
        await new Promise((r) => setTimeout(r, 20));
        return json(tokenBody("fresh.access"));
      }
      if (url === "/api/v1/me")
        return bearer(init) === "Bearer fresh.access" ? json(identity) : json({}, 401);
      return json({}, 404);
    });
    mount();
    await screen.findByText("fresh.access");
    expect(tokenCalls(fetcher, "refresh_token")).toHaveLength(1);
    const first = tokenCalls(fetcher, "refresh_token")[0]!;
    expect(JSON.parse(String(first[1]?.body))).toEqual({ refresh_token: "stored.refresh" });
    expect(new Headers(first[1]?.headers).get("apikey")).toBe("sb_publishable_synthetic");
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!).access_token).toBe("fresh.access");
  });

  it("final review: the rotated refresh token is stored as soon as the refresh succeeds", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(stored({ expires_at: Date.now() - 1000 })));
    let seenAtMe: string | null = null;
    mockFetch(async (url) => {
      if (url.includes("grant_type=refresh_token"))
        return json(tokenBody("fresh.access", "rotated.refresh"));
      if (url === "/api/v1/me") {
        // Before the identity is known, storage already holds the rotated refresh token.
        seenAtMe = JSON.parse(window.sessionStorage.getItem(KEY)!).refresh_token;
        return json(identity);
      }
      return json({}, 404);
    });
    mount();
    await screen.findByText("fresh.access");
    expect(seenAtMe).toBe("rotated.refresh");
  });

  it("final review: a restore that fails after a refresh clears the stored session", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(stored({ expires_at: Date.now() - 1000 })));
    mockFetch(async (url) => {
      if (url.includes("grant_type=refresh_token"))
        return json(tokenBody("fresh.access", "rotated.refresh"));
      if (url === "/api/v1/me") return json({}, 503);
      return json({}, 404);
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("unauthenticated"));
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("concurrent refreshAccessToken calls share one request", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(stored()));
    const fetcher = mockFetch(async (url) => {
      if (url.includes("grant_type=refresh_token")) {
        await new Promise((r) => setTimeout(r, 20));
        return json(tokenBody("shared.access"));
      }
      if (url === "/api/v1/me") return json(identity);
      return json({}, 404);
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    let results: Array<string | null> = [];
    await act(async () => {
      results = await Promise.all([
        refreshApi!.refreshAccessToken(),
        refreshApi!.refreshAccessToken(),
        refreshApi!.refreshAccessToken(),
      ]);
    });
    expect(results).toEqual(["shared.access", "shared.access", "shared.access"]);
    expect(tokenCalls(fetcher, "refresh_token")).toHaveLength(1);
  });

  it("refreshes once on a 401 while restoring", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(stored()));
    const fetcher = mockFetch((url, init) => {
      if (url.includes("grant_type=refresh_token")) return json(tokenBody("after401.access"));
      if (url === "/api/v1/me")
        return bearer(init) === "Bearer after401.access" ? json(identity) : json({}, 401);
      return json({}, 404);
    });
    mount();
    await screen.findByText("after401.access");
    expect(tokenCalls(fetcher, "refresh_token")).toHaveLength(1);
  });

  it("failed refresh clears storage and logs out", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(stored({ expires_at: Date.now() - 1000 })));
    mockFetch((url) => {
      if (url.includes("grant_type=refresh_token")) return json({ error: "invalid" }, 400);
      return json({}, 404);
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("unauthenticated"));
    expect(screen.getByTestId("token").textContent).toBe("no-session");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("logout clears sessionStorage", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(stored()));
    const fetcher = mockFetch((url) => (url === "/api/v1/me" ? json(identity) : json({}, 204)));
    mount();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    fireEvent.click(screen.getByText("Logout"));
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(screen.getByTestId("status").textContent).toBe("unauthenticated");
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("logout?scope=local"))).toBe(
        true,
      ),
    );
  });

  it.each(["{not json", '{"access_token":"x"}', "null", '"str"'])(
    "discards corrupted stored session %s safely",
    async (raw) => {
      window.sessionStorage.setItem(KEY, raw);
      const fetcher = mockFetch(() => json({}, 404));
      mount();
      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("unauthenticated"));
      expect(window.sessionStorage.getItem(KEY)).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("stores the new access token returned by the fresh-MFA re-verify", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(stored()));
    const factor = "22222222-2222-4222-8222-222222222222";
    mockFetch((url) => {
      if (url === "/api/v1/me") return json(identity);
      if (url.endsWith("/auth/v1/user"))
        return json({ factors: [{ id: factor, factor_type: "totp", status: "verified" }] });
      if (url.endsWith("/challenge")) return json({ id: "challenge-1" });
      if (url.endsWith("/verify")) return json(tokenBody("aal2.access", "aal2.refresh"));
      return json({}, 404);
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    fireEvent.click(screen.getByText("MFA"));
    await screen.findByText("aal2.access");
    const raw = JSON.parse(window.sessionStorage.getItem(KEY)!);
    expect(raw.access_token).toBe("aal2.access");
    expect(raw.refresh_token).toBe("aal2.refresh");
  });
});
