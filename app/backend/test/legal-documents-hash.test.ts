import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLegalRequiredDocuments } from "../src/legal/legal-acceptance.js";

const repo = resolve(import.meta.dirname, "../../..");
const legalDir = resolve(repo, "app/frontend/public/legal");
const files = {
  terms: "termos-de-uso.html",
  privacy: "politica-de-privacidade.html",
  refund: "politica-de-reembolso.html",
} as const;
const sha256 = (file: string) =>
  createHash("sha256")
    .update(readFileSync(resolve(legalDir, file)))
    .digest("hex");
const configured = readFileSync(
  resolve(repo, "docs/operations/legal-required-documents.json"),
  "utf8",
);

describe("published legal documents match the required-documents configuration", () => {
  it("the operations JSON is a valid LEGAL_REQUIRED_DOCUMENTS value", () => {
    expect(() => parseLegalRequiredDocuments(configured)).not.toThrow();
  });
  it("recomputes every SHA-256 from the HTML on disk and equals the configured hashes", () => {
    const parsed = parseLegalRequiredDocuments(configured);
    for (const [document, file] of Object.entries(files))
      expect(parsed.find((d) => d.document === document)?.sha256, document).toBe(sha256(file));
  });
  it("the published HTML is LF-only so the hash is identical on every checkout", () => {
    for (const file of Object.values(files))
      expect(readFileSync(resolve(legalDir, file)).includes(13), file).toBe(false);
  });
  it("keeps the agreed version labels", () => {
    const parsed = Object.fromEntries(
      parseLegalRequiredDocuments(configured).map((d) => [d.document, d.version]),
    );
    expect(parsed).toEqual({
      terms: "draft-0.9-2026-11-03",
      privacy: "draft-0.9-2026-11-03",
      refund: "2026-11-02",
    });
  });
  it("the .env.example example line equals the operations JSON", () => {
    const line = readFileSync(resolve(repo, "app/backend/.env.example"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("LEGAL_REQUIRED_DOCUMENTS="));
    expect(JSON.parse(line!.slice("LEGAL_REQUIRED_DOCUMENTS=".length))).toEqual(
      JSON.parse(configured),
    );
  });
});
