import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { AuthenticationError, type Customer, type CustomerRepository } from "../src/auth/customer-access.js";
import { InMemorySettlementRepository } from "../src/repositories/in-memory-settlement-repository.js";
import { CreateSettlementService } from "../src/application/create-settlement.js";

const alice = randomUUID(), bob = randomUUID();
class Customers implements CustomerRepository {
  profiles = new Map<string, Customer>();
  ownership = new Map<string, string>();
  async findByOwner(id: string) { return this.profiles.get(id) ?? null; }
  async createOrGet(input: { ownerUserId: string; type: "pf" | "pj"; displayName: string }) {
    const existing = await this.findByOwner(input.ownerUserId);
    if (existing) return { customer: existing, created: false };
    const customer: Customer = { id: randomUUID(), ...input, verificationStatus: "draft", suspended: false };
    this.profiles.set(input.ownerUserId, customer);
    return { customer, created: true };
  }
  async ownsSettlement(customerId: string, id: string) { return this.ownership.get(id) === customerId; }
}
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const customers = new Customers(), repository = new InMemorySettlementRepository();
  const authenticate = vi.fn(async (token: string) => {
    if (token === "unconfirmed") throw new AuthenticationError("EMAIL_NOT_CONFIRMED");
    if (token === "offline") throw new AuthenticationError("AUTH_UNAVAILABLE");
    if (token !== "alice" && token !== "bob") throw new AuthenticationError("INVALID_TOKEN");
    return { id: token === "alice" ? alice : bob, email: `${token}@example.test` };
  });
  const provider = vi.fn(async () => { throw new Error("Provider must not run"); });
  const app = await buildApp({ customerAccess: { customers, authenticate }, settlementRepository: repository,
    sandboxPixPaymentSimulator: { execute: provider },
  });
  apps.push(app);
  const settlement = (await new CreateSettlementService(repository).execute({ requestId: randomUUID(), corridorId: "ab".repeat(32), payerWallet: "11111111111111111111111111111112", recipientWallet: "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR", sourceAmount: "1", destinationAmount: "1", expiresAt: "2099-01-01T00:00:00Z" })).settlement;
  const profile = (await customers.createOrGet({ ownerUserId: alice, type: "pf", displayName: "Alice" })).customer;
  customers.ownership.set(settlement.id, profile.id);
  return { app, customers, authenticate, provider, settlement, profile };
}
const headers = (token = "alice") => ({ authorization: `Bearer ${token}` });
describe("authenticated customer API", () => {
  it("keeps health public and requires a bearer on v1", async () => {
    const { app, authenticate } = await setup();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    for (const authorization of [undefined, "Basic alice", "Bearer alice extra", "Bearer alice,bob"]) {
      expect((await app.inject({ method: "GET", url: "/v1/me", ...(authorization ? { headers: { authorization } } : {}) })).statusCode).toBe(401);
    }
    expect(authenticate).not.toHaveBeenCalled();
  });
  it.each([["bad", 401], ["unconfirmed", 403], ["offline", 503]])("rejects %s before customer access", async (token, code) => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: headers(String(token)) })).statusCode).toBe(code);
  });
  it.each(["pf", "pj"])("creates %s once under the authenticated user", async type => {
    const { app } = await setup();
    const input = { method: "POST" as const, url: "/v1/me/customer", headers: headers("bob"), payload: { type, display_name: "Bob" } };
    const first = await app.inject(input), replay = await app.inject(input);
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ type, verification_status: "draft", operations_enabled: false });
    expect(replay.json().data.id).toBe(first.json().data.id);
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: headers("bob") });
    expect(me.json().data.user.id).toBe(bob);
    expect(me.json().data.customer.id).toBe(first.json().data.id);
    expect((await app.inject({ ...input, payload: { type, display_name: "Changed" } })).statusCode).toBe(409);
  });
  it.each(["owner_user_id", "id", "verification_status", "suspended", "operations_enabled"])("rejects client-supplied %s", async field => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/v1/me/customer", headers: headers("bob"), payload: { type: "pf", display_name: "Bob", [field]: "approved" } })).statusCode).toBe(400);
  });
  it("does not expose another user's profile", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/v1/me/customer", headers: headers("bob") });
    expect(response.json().data).toBeNull();
  });
  it("permits an owned read and hides foreign, missing and legacy settlements on every subroute", async () => {
    const { app, customers, settlement } = await setup();
    expect((await app.inject({ method: "GET", url: `/v1/settlements/${settlement.id}`, headers: headers() })).statusCode).toBe(200);
    await customers.createOrGet({ ownerUserId: bob, type: "pj", displayName: "Bob Ltd" });
    for (const suffix of ["", "/audit", "/onramp", "/offramp", "/onramp/simulate-payment", "/solana/prepare", "/solana/confirm", "/solana/rollback-demo/prepare"]) {
      const method = ["", "/audit", "/onramp"].includes(suffix) ? "GET" : "POST";
      expect((await app.inject({ method, url: `/v1/settlements/${settlement.id}${suffix}`, headers: headers("bob") })).statusCode).toBe(404);
    }
    customers.ownership.clear();
    expect((await app.inject({ method: "GET", url: `/v1/settlements/${settlement.id}`, headers: headers() })).statusCode).toBe(404);
  });
  it("blocks writes even for approved profiles until customer routing is implemented", async () => {
    const { app, profile, provider, settlement } = await setup();
    for (const status of ["draft", "approved"] as const) {
      profile.verificationStatus = status;
      for (const url of ["/v1/settlements", `/v1/settlements/${settlement.id}/onramp/simulate-payment`]) {
        const response = await app.inject({ method: "POST", url, headers: headers(), payload: {} });
        expect(response.statusCode).toBe(status === "approved" ? 503 : 403);
        expect(response.json().error.code).toBe(status === "approved" ? "OPERATIONS_NOT_ENABLED" : "CUSTOMER_NOT_APPROVED");
      }
    }
    expect(provider).not.toHaveBeenCalled();
  });
  it("suspends owned settlement access but lets the user see their profile status", async () => {
    const { app, profile, settlement } = await setup(); profile.suspended = true;
    expect((await app.inject({ method: "GET", url: `/v1/settlements/${settlement.id}`, headers: headers() })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: headers() })).json().data.customer.suspended).toBe(true);
  });
});
