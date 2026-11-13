/**
 * Hosted verification session URLs (POST/GET /verifications `session_url`).
 *
 * The OZAV spec documents the field as a `uri` without naming its host. Every
 * OZAV-owned origin in the spec is `ozav.io` or one of its subdomains
 * (`developers.ozav.io` for the API this client calls, `ozav.io` for terms,
 * `storage.ozav.io` for uploads). A session URL is only accepted when it is an
 * https URL on that registrable domain, on the default port, with no embedded
 * credentials. Anything else is treated as a provider response we cannot trust,
 * so the browser is never sent to it.
 */
export const OZAV_HOSTED_SESSION_DOMAIN = "ozav.io";

export function isAllowedHostedSessionUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password
    && (host === OZAV_HOSTED_SESSION_DOMAIN || host.endsWith(`.${OZAV_HOSTED_SESSION_DOMAIN}`));
}
