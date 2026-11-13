// Guards the wiring that makes the real-PostgreSQL race tests (*.pg.test.ts) run in CI:
// the backend job exposes TEST_INVITE_DATABASE_URL (postgres:17 service on 127.0.0.1) to
// `npm test`, and every *.pg.test.ts takes its URL from realPostgresUrl(), which refuses to
// skip when CI=true.
import {readFile,readdir} from "node:fs/promises";
import {afterEach,describe,expect,it,vi} from "vitest";
import {realPostgresUrl} from "./helpers/real-postgres.js";

afterEach(()=>{vi.unstubAllEnvs();});

describe("real-PostgreSQL race tests in CI",()=>{
 it("the backend job runs npm test with TEST_INVITE_DATABASE_URL pointing at its postgres service",async()=>{
  const ci=await readFile(new URL("../../../.github/workflows/ci.yml",import.meta.url),"utf8");
  const backend=ci.slice(ci.indexOf("  backend:"),ci.indexOf("  frontend:"));
  expect(backend).toContain("image: postgres:17");
  expect(backend).toMatch(/\n {4}env:\n {6}TEST_INVITE_DATABASE_URL: postgres:\/\/invitation_test:invitation_test@127\.0\.0\.1:5432\/invitation_test\n/);
  expect(backend).toContain("working-directory: app/backend");
  expect(backend).toMatch(/- run: npm test/);
 });
 it("every *.pg.test.ts uses realPostgresUrl() and vitest picks the files up",async()=>{
  const files=(await readdir(new URL("./",import.meta.url))).filter(f=>f.endsWith(".pg.test.ts"));
  expect(files.sort()).toEqual(["customer-purchase-cancel-race.pg.test.ts","withdrawal-approval-refund-race.pg.test.ts","withdrawal-execution-race.pg.test.ts"]);
  for(const f of files){
   const text=await readFile(new URL(f,import.meta.url),"utf8");
   expect(text,f).toContain("const realUrl=realPostgresUrl();");
   expect(text,f).not.toMatch(/process\.env\.TEST_INVITE_DATABASE_URL/);
   expect(text,f).toMatch(/describe\.skipIf\(!realUrl\)/);
  }
 });
 it("refuses to skip in CI and refuses a non-local database",()=>{
  vi.stubEnv("TEST_INVITE_DATABASE_URL","");vi.stubEnv("CI","true");
  expect(()=>realPostgresUrl()).toThrow("TEST_INVITE_DATABASE_URL_REQUIRED_IN_CI");
  vi.stubEnv("CI","");expect(realPostgresUrl()).toBe("");
  vi.stubEnv("TEST_INVITE_DATABASE_URL","postgres://u:p@db.example.test:5432/x");
  expect(()=>realPostgresUrl()).toThrow("DISPOSABLE_LOCAL_DATABASE_REQUIRED");
 });
});
