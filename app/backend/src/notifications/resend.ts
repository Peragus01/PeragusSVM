export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}
export class ResendSender {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async send(id: string, message: EmailMessage): Promise<string> {
    let reason = "NETWORK_ERROR";
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
      if (!response.ok) {
        reason = [400, 401, 403, 404, 409, 422, 429].includes(response.status)
          ? `HTTP_${response.status}`
          : response.status >= 500 ? "HTTP_5XX" : "HTTP_OTHER";
        throw new Error("rejected");
      }
      reason = "INVALID_RESPONSE";
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
    } catch (error) {
      if (reason === "NETWORK_ERROR" && error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) reason = "TIMEOUT";
      console.warn(JSON.stringify({ event: "onboarding_email_send_unconfirmed", reason }));
      throw new Error("RESEND_SEND_UNCONFIRMED");
    }
  }
}
