import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { verifyDatabaseConnection } from "../src/database/readiness.js";
import { notificationFailure } from "../src/notifications/runtime-safety.js";

function fixture(encrypted: boolean) {
  const release = vi.fn();
  const client = {
    connection: { stream: { encrypted } },
    release,
    query: async () => ({
      rows: [
        {
          database_ok: true,
          role_ok: true,
          schema_ok: true,
          backend_tls: false,
        },
      ],
    }),
  };
  return { pool: { connect: async () => client } as unknown as Pool, release };
}
describe("database connection readiness behind a pooler", () => {
  it("verifies client TLS independently of the pooler's backend transport", async () => {
    const { pool, release } = fixture(true);
    await expect(verifyDatabaseConnection(pool)).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });
  it("rejects an unencrypted client socket and releases the connection", async () => {
    const { pool, release } = fixture(false);
    try {
      await verifyDatabaseConnection(pool);
      throw Error("Expected TLS rejection");
    } catch (error) {
      expect(
        notificationFailure(error, "readiness", "staging", "synthetic").fields,
      ).toEqual(["DATABASE_TLS"]);
    }
    expect(release).toHaveBeenCalledOnce();
  });
});
