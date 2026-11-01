export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}
export class ResendSender {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async send(id: string, message: EmailMessage): Promise<string> {
    try {
      const response = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `peragus-onboarding-test/${id}`,
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("rejected");
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("id" in body) ||
        typeof body.id !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(body.id)
      )
        throw new Error("invalid");
      return body.id;
    } catch {
      throw new Error("RESEND_SEND_UNCONFIRMED");
    }
  }
}
