import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import prettier from "prettier";
import { describe, expect, it } from "vitest";

describe("temporary wave two formatting snapshot", () => {
  it("prints exact repository Prettier output for changed frontend TypeScript", async () => {
    const names = [
      "src/lib/peragus/customer-ux.ts",
      "src/components/peragus/customer-onboarding.tsx",
      "src/routes/app.index.tsx",
      "src/routes/app.comprar-usdt.tsx",
      "src/routes/app.minha-conta.tsx",
      "src/components/peragus/customer-ui.tsx",
      "src/routes/app.operacoes.index.tsx",
      "src/test/customer-ux.test.ts"
];
    for (const name of names) {
      const path = resolve(process.cwd(), name);
      const config = await prettier.resolveConfig(path);
      const source = readFileSync(path, "utf8");
      const result = await prettier.format(source, { ...config, filepath: path });
      console.log("@@PERAGUS_WAVE2_FMT|" + name + "|" + Buffer.from(result, "utf8").toString("base64"));
    }
    expect(names.length).toBe(8);
  });
});
