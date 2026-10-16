import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createSupabaseAuthenticator } from "../src/auth/supabase-authenticator.js";
const origin = "https://lybdkqkbwlfwvmmvstzi.supabase.co";
const user = { id: randomUUID(), email: "alice@example.test", email_confirmed_at: "2026-10-16T12:00:00Z", is_anonymous: false };
const mockFetch = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
describe("Supabase server token validation", () => {
  it("uses the configured project Auth server and returns only verified identity", async () => {
    const fetcher = mockFetch(user);
    const auth = createSupabaseAuthenticator(origin, "sb_publishable_test", fetcher);
    expect(await auth("opaque-access-token")).toEqual({ id: user.id, email: user.email });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${origin}/auth/v1/user`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer opaque-access-token");
    expect(init.redirect).toBe("error");
  });
  it.each([401, 403])("rejects Auth denial %s", async status => {
    const auth = createSupabaseAuthenticator(origin, "sb_publishable_test", mockFetch({ msg: "invalid" }, status));
    await expect(auth("invalid")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
  it("fails closed on transport failure without returning credential details", async () => {
    const auth = createSupabaseAuthenticator(origin, "sb_publishable_test", async () => { throw new Error("secret-token"); });
    await expect(auth("secret-token")).rejects.toMatchObject({ code: "AUTH_UNAVAILABLE", message: "AUTH_UNAVAILABLE" });
  });
  it.each([{ ...user, email_confirmed_at: null }, { ...user, is_anonymous: true }, { ...user, id: "not-a-uuid" }])("rejects unverified/malformed identity", async body => {
    await expect(createSupabaseAuthenticator(origin, "sb_publishable_test", mockFetch(body))("token")).rejects.toThrow();
  });
  it.each(["http://example.test", `${origin}.evil.test`, `${origin}/auth`, `${origin}?x=1`])("rejects unexpected Auth origin %s", url => {
    expect(() => createSupabaseAuthenticator(url, "key")).toThrow();
  });
});
