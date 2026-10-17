import { createHash } from "node:crypto";
import type { OzavClient, OzavSandboxCustomerInput, OzavSandboxCustomer, OzavCustomerSnapshot } from "../providers/ozav-client.js";

export interface SandboxCustomerLink {
  customerId: string;
  environment: "test";
  idempotencyKey: string;
  requestHash: string;
  state: "pending" | "linked";
  ozavCustomerId: string | null;
  providerStatus: string | null;
  verificationMode: "full" | "reliance" | null;
  snapshot: OzavCustomerSnapshot | null;
  snapshotVersion: number;
  refreshedAt: string | null;
}
export interface SandboxCustomerLinkRepository {
  saveSnapshot(customerId: string, providerId: string, version: number, snapshot: OzavCustomerSnapshot): Promise<SandboxCustomerLink>;
  find(customerId: string): Promise<SandboxCustomerLink | null>;
  reserve(customerId: string, requestHash: string, idempotencyKey: string): Promise<SandboxCustomerLink>;
  complete(customerId: string, requestHash: string, result: OzavSandboxCustomer): Promise<SandboxCustomerLink>;
}
export class SandboxCustomerError extends Error {
  constructor(public readonly code: "SANDBOX_CUSTOMER_CONFLICT" | "SANDBOX_CUSTOMER_CAPABILITY_MISSING" | "SANDBOX_CUSTOMER_ENVIRONMENT_MISMATCH") { super(code); }
}

// Generated fictitious data is for this test-only endpoint, not a representation
// of the authenticated person's legal identity. No documents or attestations.
export function sandboxCustomerFixture(customerId: string): OzavSandboxCustomerInput {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(customerId)) throw new Error("Invalid customer id");
  const seed = createHash("sha256").update(`peragus:ozav:fixture:v1:${customerId}`).digest();
  const digits = Array.from(seed.subarray(0, 9), byte => byte % 10);
  // Avoid repeated-digit CPF values, which fail the checksum validator.
  if (digits.every(digit => digit === digits[0])) digits[8] = (digits[8]! + 1) % 10;
  for (const factor of [10, 11]) {
    const sum = digits.reduce((total, digit, i) => total + digit * (factor - i), 0);
    const remainder = (sum * 10) % 11;
    digits.push(remainder === 10 ? 0 : remainder);
  }
  return {
    externalRef: `peragus-sandbox:${customerId}`, email: `peragus-sandbox-${customerId}@example.com`,
    legalName: "Teste Peragus Sandbox", taxId: digits.join(""),
  };
}
export class OzavSandboxCustomerService {
  constructor(private readonly links: SandboxCustomerLinkRepository,
    private readonly client: Pick<OzavClient, "getCustomerCapabilities" | "createSandboxCustomer" | "getSandboxCustomerSnapshot">) {}
  async read(customerId: string) { return this.links.find(customerId); }
  async refresh(customerId: string) {
    const link = await this.links.find(customerId);
    if (!link || link.state !== "linked" || !link.ozavCustomerId || link.environment !== "test") {
      throw new SandboxCustomerError("SANDBOX_CUSTOMER_CONFLICT");
    }
    const capabilities = await this.client.getCustomerCapabilities();
    if (capabilities.environment !== "test") throw new SandboxCustomerError("SANDBOX_CUSTOMER_ENVIRONMENT_MISMATCH");
    if (!capabilities.entitlements.includes("customers") || !capabilities.scopes.includes("customers:read")) {
      throw new SandboxCustomerError("SANDBOX_CUSTOMER_CAPABILITY_MISSING");
    }
    const snapshot = await this.client.getSandboxCustomerSnapshot(link.ozavCustomerId, sandboxCustomerFixture(customerId).externalRef);
    return this.links.saveSnapshot(customerId, link.ozavCustomerId, link.snapshotVersion, snapshot);
  }
  async execute(customerId: string) {
    const fixture = sandboxCustomerFixture(customerId);
    const hash = createHash("sha256").update(JSON.stringify({ version: 1, fixture, verificationMode: "full", custodyModel: "managed" })).digest("hex");
    const link = await this.links.reserve(customerId, hash, `peragus-customer-test-${customerId}`);
    if (link.environment !== "test") throw new SandboxCustomerError("SANDBOX_CUSTOMER_ENVIRONMENT_MISMATCH");
    if (link.requestHash !== hash) throw new SandboxCustomerError("SANDBOX_CUSTOMER_CONFLICT");
    if (link.state === "linked") return { link, replayed: true };
    const capabilities = await this.client.getCustomerCapabilities();
    if (capabilities.environment !== "test") throw new SandboxCustomerError("SANDBOX_CUSTOMER_ENVIRONMENT_MISMATCH");
    if (!["customers", "custody"].every(v => capabilities.entitlements.includes(v))
      || !capabilities.scopes.includes("customers:write")) throw new SandboxCustomerError("SANDBOX_CUSTOMER_CAPABILITY_MISSING");
    const result = await this.client.createSandboxCustomer(fixture, link.idempotencyKey);
    if (result.externalRef !== fixture.externalRef || result.email !== fixture.email || result.verificationMode === "reliance") {
      throw new SandboxCustomerError("SANDBOX_CUSTOMER_CONFLICT");
    }
    return { link: await this.links.complete(customerId, hash, result), replayed: false };
  }
}
