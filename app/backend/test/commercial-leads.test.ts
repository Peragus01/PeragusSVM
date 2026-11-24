import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerCommercialLeadRoute } from "../src/routes/commercial-leads.js";

const database = new PGlite();
const app = Fastify();
const url = "/public/commercial-leads";
const contact = {
  fullName: "Test Lead",
  corporateEmail: "lead@example.test",
  company: "Local Test Company",
  position: "Director",
  country: "Brazil",
  website: "https://example.test/",
  interest: "Payment Infrastructure",
  fax: "",
};

beforeAll(async () => {
  await database.exec("create role anon; create role authenticated");
  await database.exec(await readFile(
    new URL("../migrations/057_commercial_leads.sql", import.meta.url), "utf8",
  ));
  registerCommercialLeadRoute(app, database as unknown as Pool);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

it("validates fields and rejects a filled honeypot without writing rows", async () => {
  const response = await app.inject({
    method: "POST", url, payload: { ...contact, corporateEmail: "invalid", fax: "bot" },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.fields).toEqual(["corporateEmail", "fax"]);
  expect((await database.query("select id from public.commercial_leads")).rows).toEqual([]);
});

it("persists one inquiry and deduplicates concurrent repeats with normalized email", async () => {
  const responses = await Promise.all([
    app.inject({ method: "POST", url, payload: contact }),
    app.inject({ method: "POST", url, payload: { ...contact, corporateEmail: "LEAD@example.test" } }),
  ]);
  expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
  expect(responses.map((response) => response.json())).toEqual([{ received: true }, { received: true }]);
  const rows = await database.query("select corporate_email, source, status from public.commercial_leads");
  expect(rows.rows).toEqual([{ corporate_email: contact.corporateEmail, source: "homepage", status: "new" }]);
  const permissions = await database.query(
    "select has_table_privilege('anon', 'public.commercial_leads', 'select') as anonymous_read, " +
    "has_table_privilege('authenticated', 'public.commercial_leads', 'insert') as client_write",
  );
  expect(permissions.rows).toEqual([{ anonymous_read: false, client_write: false }]);
});

it("rate-limits requests from the same address before processing more bodies", async () => {
  const responses = await Promise.all(Array.from({ length: 31 }, () =>
    app.inject({ method: "POST", url, remoteAddress: "192.0.2.10", payload: {} }),
  ));
  expect(responses.filter((response) => response.statusCode === 400)).toHaveLength(30);
  expect(responses.find((response) => response.statusCode === 429)?.headers["retry-after"]).toBeDefined();
});
