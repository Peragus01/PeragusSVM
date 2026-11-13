import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { envSchema } from "../src/config/env.js";
import { MAINNET_USDT_MINT } from "../src/config/money-environment.js";

const repo = resolve(import.meta.dirname, "../../..");
const checklist = readFileSync(
  resolve(repo, "docs/operations/configuration-checklist.md"),
  "utf8",
);
const legalJson = readFileSync(
  resolve(repo, "docs/operations/legal-required-documents.json"),
  "utf8",
);

const keys = Object.keys(envSchema.shape);
const mentions = (text: string, key: string) =>
  new RegExp(`(?<![A-Z0-9_])${key}(?![A-Z0-9_])`).test(text);
const section = (from: string, to: string) => {
  const start = checklist.indexOf(from);
  const end = checklist.indexOf(to, start + 1);
  expect(start, from).toBeGreaterThanOrEqual(0);
  expect(end, to).toBeGreaterThan(start);
  return checklist.slice(start, end);
};

describe("docs/operations/configuration-checklist.md cannot drift from env.ts", () => {
  it("reads the schema keys from env.ts", () => {
    expect(keys.length).toBeGreaterThan(50);
    expect(keys).toContain("PERAGUS_DEPLOYMENT_ENV");
  });

  it("mentions every env.ts key in the production section", () => {
    const production = section("## 1. Produção", "## 2. Staging");
    const missing = keys.filter((key) => !mentions(production, key));
    expect(missing, `undocumented in production: ${missing.join(", ")}`).toEqual([]);
  });

  it("covers the keys that gate staging boot in the staging section", () => {
    const staging = section("## 2. Staging", "## 3. GitHub");
    for (const key of [
      "PERAGUS_DEPLOYMENT_ENV",
      "OZAV_API_KEY",
      "SOLANA_RPC_URL",
      "SOLANA_USDT_MINT",
      "LEGAL_REQUIRED_DOCUMENTS",
      "TRUST_PROXY_HOPS",
      "DATABASE_URL",
      "SUPABASE_URL",
      "OPERATOR_NOTIFICATIONS_ENABLED",
    ])
      expect(mentions(staging, key), key).toBe(true);
  });

  it("documents every platform for both environments", () => {
    for (const [from, to] of [
      ["### 1.1 Railway — API de produção", "### 1.2"],
      ["### 1.2 Railway — workers de produção", "### 1.3"],
      ["### 1.3 Vercel", "### 1.4"],
      ["### 1.4 Supabase", "### 1.5"],
      ["### 1.5 Painel da OZAV", "### 1.6"],
      ["### 2.1 Railway — API de staging", "### 2.2"],
      ["### 2.2 Railway — workers de staging", "### 2.3"],
      ["### 2.3 Vercel", "### 2.4"],
      ["### 2.4 Supabase", "### 2.5"],
      ["### 2.5 Painel da OZAV", "### 2.6"],
    ] as const)
      expect(section(from, to).length, from).toBeGreaterThan(200);
    expect(checklist).toContain("## 3. GitHub");
  });

  it("states the live values the code enforces", () => {
    for (const literal of [
      MAINNET_USDT_MINT,
      "ozav_sk_live_",
      "ozav_sk_test_",
      "VITE_PERAGUS_MONEY_MODE",
      "OZAV_QUOTE_ID",
      "OZAV_TRANSFER_ID",
      "OZAV_SOLANA_ADDRESS",
      "SUPABASE_SERVICE_ROLE_KEY",
      "/webhooks/customer-updates",
      "Leaked password protection",
      "@peragus.com.br",
    ])
      expect(checklist, literal).toContain(literal);
    expect(checklist).toMatch(/`VITE_PERAGUS_MONEY_MODE` \| `live`/);
    expect(checklist).toMatch(/`TRUST_PROXY_HOPS` \| `1`/);
    expect(checklist).toMatch(/`MANUAL_REFUNDS_ENABLED` \| `true`/);
  });

  it("carries the exact LEGAL_REQUIRED_DOCUMENTS value from the operations JSON", () => {
    const compact = JSON.stringify(JSON.parse(legalJson));
    expect(checklist).toContain(compact);
  });
});
