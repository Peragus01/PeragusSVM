import { describe, expect, it, vi } from "vitest";
import { canCreateAccount, LEGAL_PRIVACY_VERSION, LEGAL_TERMS_VERSION, validLegalAcknowledgements } from "@/lib/peragus/legal-acknowledgement";
import { handleLegalSignup } from "@/lib/peragus/legal-signup.server";

const legal = { termsAccepted: true, privacyAcknowledged: true,
  termsVersion: LEGAL_TERMS_VERSION, privacyVersion: LEGAL_PRIVACY_VERSION };
const data = { email: "user@example.com", password: "correct-horse-42", inviteCode: "pginv_" + "a".repeat(43), legal };
const request = (body: unknown) => new Request("https://staging.peragus.com.br/api/registration/signup", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://staging.peragus.com.br" },
  body: JSON.stringify(body),
});
const env = { PERAGUS_BACKEND_URL: "https://backend.test", VITE_SUPABASE_URL: "https://aaaabbbb.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" };
describe("registration legal acknowledgements", () => {
  it("requires both separate checkboxes", () => {
    expect(canCreateAccount(false, false)).toBe(false);
    expect(canCreateAccount(true, false)).toBe(false);
    expect(canCreateAccount(false, true)).toBe(false);
    expect(canCreateAccount(true, true)).toBe(true);
  });
  it("rejects missing or stale versions", () => {
    expect(validLegalAcknowledgements({ ...legal, privacyAcknowledged: false })).toBe(false);
    expect(validLegalAcknowledgements({ ...legal, termsVersion: "old" })).toBe(false);
    expect(validLegalAcknowledgements(legal)).toBe(true);
  });
  it("does not contact Supabase when the terms are not acknowledged", async () => {
    const fetcher = vi.fn();
    const res = await handleLegalSignup(request({ ...data, legal: { ...legal, termsAccepted: false } }), { env, fetcher });
    expect(res.status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not contact Supabase for a version mismatch", async () => {
    const fetcher = vi.fn();
    const res = await handleLegalSignup(request({ ...data, legal: { ...legal, privacyVersion: "old" } }), { env, fetcher });
    expect(res.status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("revalidates invitation before signup", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{valid:false,environment:"test"}}),{status:200,headers:{"Content-Type":"application/json"}}));
    const res = await handleLegalSignup(request(data), { env, fetcher });
    expect(res.status).toBe(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("submits signup only when the invite and both acknowledgements are valid", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({data:{valid:true,environment:"test"}}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({user:{id:"fake"}}),{status:200}));
    const res = await handleLegalSignup(request(data), { env, fetcher });
    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://aaaabbbb.supabase.co/auth/v1/signup");
  });
});
