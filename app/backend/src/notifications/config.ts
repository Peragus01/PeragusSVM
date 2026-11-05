import { z } from "zod";
const schema = z.object({
  ONBOARDING_EMAILS_ENABLED: z.enum(["true", "false"]).default("false"),
  RESEND_API_KEY: z
    .string()
    .regex(/^re_[A-Za-z0-9_]+$/)
    .optional(),
  RESEND_FROM: z.email().optional(),
  ONBOARDING_EMAIL_ACCOUNT_URL: z.url().optional(),
  ONBOARDING_EMAIL_TEST_USER_IDS: z.string().default(""),
});
export function notificationConfig(input: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error("ONBOARDING_EMAIL_CONFIG_INVALID");
  const c = parsed.data,
    enabled = c.ONBOARDING_EMAILS_ENABLED === "true";
  const owners = c.ONBOARDING_EMAIL_TEST_USER_IDS.split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (owners.length > 5 || owners.some((id) => !z.uuid().safeParse(id).success))
    throw new Error("ONBOARDING_EMAIL_TEST_ALLOWLIST_INVALID");
  if (
    enabled &&
    (!c.RESEND_API_KEY ||
      !c.RESEND_FROM ||
      !c.ONBOARDING_EMAIL_ACCOUNT_URL ||
      !owners.length)
  )
    throw new Error("ONBOARDING_EMAIL_CONFIG_REQUIRED");
  if (c.ONBOARDING_EMAIL_ACCOUNT_URL) {
    const url = new URL(c.ONBOARDING_EMAIL_ACCOUNT_URL);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("ONBOARDING_EMAIL_URL_INVALID");
  }
  return {
    enabled,
    key: c.RESEND_API_KEY,
    from: c.RESEND_FROM,
    accountUrl: c.ONBOARDING_EMAIL_ACCOUNT_URL,
    owners,
  };
}
