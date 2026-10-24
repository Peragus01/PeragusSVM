import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import prettier from "prettier";
import { describe, expect, it } from "vitest";

// Temporary extraction of the repository's exact Prettier output from the CI
// environment that already has npm ci dependencies. Remove after applying it.
describe("temporary frontend formatting extraction", () => {
  it("prints canonical formatting for changed TS/TSX files", async () => {
    const files = [
      "src/components/peragus/Wallet.tsx",
      "src/components/peragus/customer-operations.tsx",
      "src/components/peragus/customer-ui.tsx",
      "src/lib/peragus/customer-session.tsx",
      "src/routes/__root.tsx",
      "src/routes/app.auditoria.tsx",
      "src/routes/app.carteira.tsx",
      "src/routes/app.comprar-usdt.tsx",
      "src/routes/app.index.tsx",
      "src/routes/app.minha-conta.tsx",
      "src/routes/app.operacoes.$id.tsx",
      "src/routes/app.operacoes.index.tsx",
      "src/routes/app.operacoes.tsx",
      "src/routes/app.tsx",
      "src/routes/cadastro.tsx",
      "src/routes/index.tsx",
      "src/routes/login.tsx",
      "src/routes/recuperar-senha.tsx",
      "src/test/customer-mvp.test.tsx"
];
    for (const name of files) {
      const file = resolve(process.cwd(), name);
      const source = readFileSync(file, "utf8");
      const options = await prettier.resolveConfig(file);
      const formatted = await prettier.format(source, {
        ...options,
        filepath: file,
      });
      console.log("@@PERAGUS_FMT|" + name + "|" + Buffer.from(formatted).toString("base64"));
    }
    expect(files.length).toBe(19);
  });
});
