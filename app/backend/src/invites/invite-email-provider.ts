export class InviteProviderError extends Error {
  constructor(public readonly definitive: boolean) {
    super("INVITE_PROVIDER_UNCONFIRMED");
  }
}
/** Separate from onboarding sender: no changes to another queue's key or behavior. */
export class InviteEmailProvider {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly pollDelivery = true,
  ) {}
  async send(key: string, body: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new InviteProviderError(false);
    }
    if (!response.ok)
      throw new InviteProviderError(
        [400, 401, 403, 404, 422].includes(response.status),
      );
    try {
      const data = (await response.json()) as { id?: unknown };
      if (typeof data.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(data.id))
        throw Error();
      return data.id;
    } catch {
      throw new InviteProviderError(false);
    }
  }
  async status(id: string): Promise<string | null> {
    if (!this.pollDelivery) return null;
    try {
      const r = await this.fetcher(
        `https://api.resend.com/emails/${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${this.key}` },
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!r.ok) return null;
      const d = (await r.json()) as { id?: unknown; last_event?: unknown };
      return d.id === id && typeof d.last_event === "string"
        ? d.last_event
        : null;
    } catch {
      return null;
    }
  }
}
