/**
 * OZAV hosted identity verification (live only). The backend already validates the
 * link; the browser checks it again before leaving the site, so a response can never
 * turn this screen into an open redirect: https only, default port, no credentials,
 * and the host must be ozav.io or one of its subdomains.
 */
export const OZAV_HOSTED_SESSION_DOMAIN = "ozav.io";

export function hostedSessionUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    url.protocol === "https:" &&
    url.port === "" &&
    !url.username &&
    !url.password &&
    (host === OZAV_HOSTED_SESSION_DOMAIN || host.endsWith(`.${OZAV_HOSTED_SESSION_DOMAIN}`));
  return allowed ? url.toString() : null;
}

/** Browser navigation used to leave for OZAV's hosted verification (replaced in tests). */
export const browserNavigation = {
  assign(url: string) {
    window.location.assign(url);
  },
};
