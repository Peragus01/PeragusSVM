import { it, expect } from "vitest";
import {
  invitationMessage,
  INVITE_STAGING_ORIGIN,
} from "../src/invites/invite-email-template.js";
it("freezes a production link while retaining synthetic labels and no code in URL", () => {
  const code = "pginv_" + "x".repeat(43);
  const message = JSON.parse(
    invitationMessage(
      "synthetic@example.com",
      code,
      "noreply@peragus.com.br",
      "https://www.peragus.com.br",
    ),
  );
  expect(message.text).toContain("https://www.peragus.com.br/cadastro");
  expect(message.text).not.toContain(INVITE_STAGING_ORIGIN);
  expect(message.html).toContain('href="https://www.peragus.com.br/cadastro"');
  expect(message.subject).toContain("TESTES");
  expect(() =>
    invitationMessage(
      "synthetic@example.com",
      code,
      "noreply@peragus.com.br",
      "https://attacker.example",
    ),
  ).toThrow("ORIGIN_INVALID");
});
