import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { PilotInviteService } from "../src/invites/pilot-invites.js";
import { InviteEmailCipher } from "../src/invites/invite-email-cipher.js";
import {
  InviteProviderError,
  InviteEmailProvider,
} from "../src/invites/invite-email-provider.js";
import {
  processInviteEmail,
  type InviteDeliveryProvider,
} from "../src/invites/invite-email-processor.js";
import {
  invitationMessage,
  INVITE_STAGING_ORIGIN,
} from "../src/invites/invite-email-template.js";
const realUrl = process.env.TEST_INVITE_DATABASE_URL;
if (realUrl) {
  const u = new URL(realUrl);
  if (
    !["localhost", "127.0.0.1"].includes(u.hostname) ||
    u.pathname !== "/invitation_test"
  )
    throw Error("DISPOSABLE_LOCAL_INVITE_DATABASE_REQUIRED");
}
for (const mode of ["embedded", ...(realUrl ? ["postgres"] : [])])
  describe(`encrypted invite delivery (${mode})`, () => {
    const real = mode === "postgres",
      embedded = real ? null : new PGlite(),
      pg = real ? new Pool({ connectionString: realUrl, max: 12 }) : null;
    const db = {
      query: async (sql: string, args?: unknown[]) => {
        const r = real
          ? await pg!.query(sql, args)
          : await embedded!.query(sql, args);
        const result = Array.isArray(r) ? r.at(-1)! : r;
        return { ...result, rowCount: result.rows.length };
      },
    } as unknown as Pool;
    const operator = {
      id: randomUUID(),
      email: "operator@example.test",
      assuranceLevel: "aal2" as const,
    };
    const cipher = new InviteEmailCipher(
      randomBytes(32).toString("base64"),
      "v1",
    );
    const svc = new PilotInviteService(
      db,
      new Set([operator.id]),
      true,
      "ab".repeat(32),
      cipher,
      "contato@peragus.com.br",
    );
    const reason = "Synthetic invitation delivery test";
    const provider: InviteDeliveryProvider = {
      send: vi.fn(async () => randomUUID()),
      status: vi.fn(async () => null),
    };
    const issue = (email = "test@example.test", request = randomUUID()) =>
      svc.issueEmail(operator, request, email, 24, reason);
    const row = async (id: string) =>
      (
        await db.query(
          "select * from peragus_invite_email_outbox where invite_id=$1",
          [id],
        )
      ).rows[0]!;
    async function process(
      custom = provider,
      intercept?: (sql: string) => void,
    ) {
      const client = real ? await pg!.connect() : null;
      const q = {
        query: async (sql: string, args?: unknown[]) => {
          intercept?.(sql);
          return client ? client.query(sql, args) : db.query(sql, args);
        },
      } as Pick<PoolClient, "query">;
      try {
        return await processInviteEmail(q, cipher, custom);
      } finally {
        client?.release();
      }
    }
    async function due(id: string) {
      await db.query(
        "update peragus_invite_email_outbox set next_attempt_at=clock_timestamp()-interval '1 minute' where invite_id=$1",
        [id],
      );
    }
    beforeAll(async () => {
      await db.query("create role anon");
      await db.query("create role authenticated");
      const dir = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((n) => /^\d+_.*\.sql$/.test(n))
        .sort()) {
        const sql = await readFile(new URL(name, dir), "utf8");
        if (real) await db.query(sql);
        else await embedded!.exec(sql);
      }
    }, 60000);
    beforeEach(async () => {
      await db.query(
        "truncate peragus_customers,peragus_pilot_invites,peragus_pilot_invite_slots,peragus_pilot_invite_rate_limits cascade",
      );
      await db.query(
        "insert into peragus_pilot_invite_slots(slot) select generate_series(1,5)",
      );
      vi.mocked(provider.send)
        .mockReset()
        .mockImplementation(async () => randomUUID());
      vi.mocked(provider.status).mockReset().mockResolvedValue(null);
    });
    afterAll(async () => {
      await pg?.end();
      await embedded?.close();
    });
    it("atomically rolls back invitation and allocation if queue fails; hides secrets and rejects changed replays", async () => {
      await db.query(
        "alter table peragus_invite_email_outbox add constraint test_fail check(false)",
      );
      await expect(issue()).rejects.toThrow();
      expect(
        (await db.query("select id from peragus_pilot_invites")).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            "select slot from peragus_pilot_invite_slots where current_invite_id is not null",
          )
        ).rows,
      ).toHaveLength(0);
      await db.query(
        "alter table peragus_invite_email_outbox drop constraint test_fail",
      );
      const request = randomUUID(),
        value = await issue("test@example.test", request),
        queued = await row(value.data.id);
      expect(value.code).toBeNull();
      expect(cipher.open(value.data.id, queued.encrypted_payload).email).toBe(
        "test@example.test",
      );
      expect(JSON.stringify(queued)).not.toContain("test@example.test");
      expect((await issue("test@example.test", request)).replayed).toBe(true);
      await expect(issue("other@example.test", request)).rejects.toThrow(
        "IDEMPOTENCY_CONFLICT",
      );
      expect(
        (await db.query("select invite_id from peragus_invite_email_outbox"))
          .rows,
      ).toHaveLength(1);
      const history = await svc.list(operator);
      expect(history[0]?.email_delivery?.state).toBe("pending");
      expect(JSON.stringify(history)).not.toContain("test@example.test");
      for (const user of [
        { ...operator, assuranceLevel: "aal1" as const },
        { ...operator, id: randomUUID() },
      ]) {
        await expect(svc.list(user)).rejects.toThrow();
        await expect(
          svc.issueEmail(user, randomUUID(), "none@example.test", 24, reason),
        ).rejects.toThrow();
      }
      for (const role of ["anon", "authenticated"])
        expect(
          (
            await db.query(
              "select has_table_privilege($1,'peragus_invite_email_outbox','select') as allowed",
              [role],
            )
          ).rows[0].allowed,
        ).toBe(false);
    });
    it("handles concurrent issuance, identical request and duplicate email without stranding slots", async () => {
      const req = randomUUID(),
        results = await Promise.all(
          Array.from({ length: 5 }, () => issue("same@example.test", req)),
        );
      expect(new Set(results.map((r) => r.data.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      const conflict = await Promise.allSettled([
        issue("unique@example.test"),
        issue("unique@example.test"),
      ]);
      expect(conflict.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (await db.query("select invite_id from peragus_invite_email_outbox"))
          .rows,
      ).toHaveLength(2);
      expect(
        (
          await db.query(
            "select slot from peragus_pilot_invite_slots where current_invite_id is not null",
          )
        ).rows,
      ).toHaveLength(2);
    });
    it("freezes exact HTML/text/sender/recipient/code/link/key across ambiguous retry and distinguishes delivery", async () => {
      const value = await issue(),
        before = await row(value.data.id);
      vi.mocked(provider.send).mockRejectedValueOnce(
        new InviteProviderError(false),
      );
      await process();
      expect((await row(value.data.id)).state).toBe("uncertain");
      await due(value.data.id);
      await process();
      expect(provider.send).toHaveBeenCalledTimes(2);
      expect(vi.mocked(provider.send).mock.calls[0]).toEqual(
        vi.mocked(provider.send).mock.calls[1],
      );
      const [key, body] = vi.mocked(provider.send).mock.calls[0]!,
        message = JSON.parse(body),
        clear = cipher.open(value.data.id, before.encrypted_payload);
      expect(key).toBe("peragus-invitation-test/" + value.data.id);
      for (const content of [message.html, message.text]) {
        expect(content).toContain(clear.code);
        expect(content).toContain(INVITE_STAGING_ORIGIN + "/cadastro");
        expect(content).toContain("TESTES");
      }
      expect(message.html).toContain(
        "https://www.peragus.com.br/logo-peragus.png",
      );
      expect(message.html).toContain('lang="pt-BR"');
      expect(message.to).toBe(clear.email);
      expect(message.html).not.toContain("?code=");
      const accepted = await row(value.data.id);
      expect(accepted.state).toBe("accepted");
      expect(accepted.encrypted_payload).toBeNull();
      expect(accepted.attempt_count).toBe(2);
      await process();
      expect((await row(value.data.id)).state).toBe("accepted");
      await db.query(
        "update peragus_invite_email_outbox set last_checked_at=null where invite_id=$1",
        [value.data.id],
      );
      vi.mocked(provider.status).mockResolvedValue("delivered");
      await process();
      expect((await row(value.data.id)).state).toBe("delivered");
      expect((await row(value.data.id)).delivered_at).toBeTruthy();
    });
    it("recovers acceptance followed by database failure using the same message/key", async () => {
      const value = await issue();
      let failed = false;
      const providerId = randomUUID();
      vi.mocked(provider.send).mockResolvedValue(providerId);
      await process(provider, (sql) => {
        if (sql.includes("state='accepted'") && !failed) {
          failed = true;
          throw Error("synthetic database failure");
        }
      });
      const uncertain = await row(value.data.id);
      expect(uncertain.state).toBe("uncertain");
      expect(uncertain.encrypted_payload).toBeTruthy();
      await due(value.data.id);
      await process();
      expect(vi.mocked(provider.send).mock.calls[0]).toEqual(
        vi.mocked(provider.send).mock.calls[1],
      );
      expect((await row(value.data.id)).provider_email_id).toBe(providerId);
    });
    it("stops definitive rejection; blocks crashed attempts after the safe window and purges content", async () => {
      const rejected = await issue();
      vi.mocked(provider.send).mockRejectedValueOnce(
        new InviteProviderError(true),
      );
      await process();
      expect((await row(rejected.data.id)).state).toBe("failed");
      expect((await row(rejected.data.id)).encrypted_payload).toBeNull();
      const unknown = await issue("unknown@example.test");
      await db.query(
        "update peragus_invite_email_outbox set state='sending',first_attempt_at=clock_timestamp()-interval '23 hours 1 minute',attempt_count=1 where invite_id=$1",
        [unknown.data.id],
      );
      await process();
      expect(provider.send).toHaveBeenCalledTimes(1);
      expect(await row(unknown.data.id)).toMatchObject({
        state: "uncertain",
        last_error: "IDEMPOTENCY_WINDOW_ELAPSED",
        encrypted_payload: null,
      });
      expect((await row(unknown.data.id)).retry_blocked_at).toBeTruthy();
    });
    it("purges revoked/redeemed invitations immediately, rejects wrong recipient and consumes once", async () => {
      const revoked = await issue();
      await svc.revoke(operator, revoked.data.id, randomUUID(), reason);
      await process();
      expect(provider.send).not.toHaveBeenCalled();
      expect(await row(revoked.data.id)).toMatchObject({
        state: "cancelled",
        encrypted_payload: null,
      });
      const value = await issue("redeem@example.test"),
        clear = cipher.open(
          value.data.id,
          (await row(value.data.id)).encrypted_payload,
        ),
        user = { id: randomUUID(), email: "redeem@example.test" },
        req = randomUUID();
      await expect(
        svc.redeem(
          { ...user, email: "wrong@example.test" },
          randomUUID(),
          clear.code,
          "Test Name",
        ),
      ).rejects.toThrow("NOT_AVAILABLE");
      await svc.redeem(user, req, clear.code, "Test Name");
      await process();
      expect(provider.send).not.toHaveBeenCalled();
      expect((await row(value.data.id)).encrypted_payload).toBeNull();
      await expect(
        svc.redeem(user, randomUUID(), clear.code, "Test Name"),
      ).rejects.toThrow("ALREADY_REDEEMED");
    });
    it("does not dispatch a naturally expiring invitation", async () => {
      const id = randomUUID(),
        code = "pginv_" + randomBytes(32).toString("base64url"),
        email = "expiry@example.test",
        sealed = cipher.seal(id, {
          email,
          code,
          message: invitationMessage(email, code, "contato@peragus.com.br"),
        });
      await db.query(
        `with s as (update peragus_pilot_invite_slots set current_invite_id=$1 where slot=1 returning slot),
   i as (insert into peragus_pilot_invites(id,slot,target_user_id,operator_user_id,request_id,reason,code_hash,duration_hours,expires_at)
   select $1,slot,$2,$3,$4,$5,$6,1,clock_timestamp()+interval '2 seconds' from s returning id)
   insert into peragus_invite_email_outbox(invite_id,idempotency_key,encrypted_payload) select id,'peragus-invitation-test/'||id::text,$7::jsonb from i`,
        [
          id,
          randomUUID(),
          operator.id,
          randomUUID(),
          reason,
          createHash("sha256").update(code).digest("hex"),
          JSON.stringify(sealed),
        ],
      );
      await process();
      expect(provider.send).not.toHaveBeenCalled();
      expect((await row(id)).encrypted_payload).toBeNull();
    });
    it.skipIf(!real)(
      "cancels dispatch when natural expiry wins while the invitation lock is held",
      async () => {
        const id = randomUUID(),
          code = "pginv_" + randomBytes(32).toString("base64url"),
          email = "expiry-race@example.test";
        const sealed = cipher.seal(id, {
          email,
          code,
          message: invitationMessage(email, code, "contato@peragus.com.br"),
        });
        await db.query(
          `with s as (update peragus_pilot_invite_slots set current_invite_id=$1 where slot=1 returning slot),
        i as (insert into peragus_pilot_invites(id,slot,target_user_id,operator_user_id,request_id,reason,code_hash,duration_hours,expires_at)
        select $1,slot,$2,$3,$4,$5,$6,1,clock_timestamp()+interval '1 second' from s returning id)
        insert into peragus_invite_email_outbox(invite_id,idempotency_key,encrypted_payload) select id,'peragus-invitation-test/'||id::text,$7::jsonb from i`,
          [
            id,
            randomUUID(),
            operator.id,
            randomUUID(),
            reason,
            createHash("sha256").update(code).digest("hex"),
            JSON.stringify(sealed),
          ],
        );
        const blocker = await pg!.connect();
        let worker: Promise<boolean> | undefined;
        try {
          await blocker.query("begin");
          await blocker.query(
            "select id from peragus_pilot_invites where id=$1 for update",
            [id],
          );
          worker = process();
          for (let n = 0; n < 50; n++) {
            if ((await row(id)).attempt_count === 1) break;
            await new Promise((r) => setTimeout(r, 10));
          }
          expect((await row(id)).attempt_count).toBe(1);
          await new Promise((r) => setTimeout(r, 1100));
        } finally {
          await blocker.query("commit");
          blocker.release();
        }
        await worker;
        expect(provider.send).not.toHaveBeenCalled();
        expect((await row(id)).encrypted_payload).toBeNull();
      },
    );
    for (const action of ["revoke", "redeem"])
      it.skipIf(!real)(
        `serializes workers and waits for dispatch before ${action} commits`,
        async () => {
          const value = await issue(),
            clear = cipher.open(
              value.data.id,
              (await row(value.data.id)).encrypted_payload,
            );
          let entered!: () => void, release!: () => void;
          const start = new Promise<void>((r) => {
              entered = r;
            }),
            gate = new Promise<void>((r) => {
              release = r;
            });
          vi.mocked(provider.send).mockImplementation(async () => {
            entered();
            await gate;
            return randomUUID();
          });
          const worker = process();
          await start;
          expect(await process()).toBe(false);
          let changed = false;
          const mutation = (
            action === "revoke"
              ? svc.revoke(operator, value.data.id, randomUUID(), reason)
              : svc.redeem(
                  { id: randomUUID(), email: "test@example.test" },
                  randomUUID(),
                  clear.code,
                  "Test Name",
                )
          ).then(() => {
            changed = true;
          });
          await new Promise((r) => setTimeout(r, 50));
          expect(changed).toBe(false);
          release();
          await worker;
          await mutation;
          expect((await row(value.data.id)).state).toBe("accepted");
          expect(provider.send).toHaveBeenCalledTimes(1);
          expect((await svc.read(operator, value.data.id)).state).toBe(
            action === "revoke" ? "revoked" : "redeemed",
          );
        },
      );
  });
describe("invitation Resend transport", () => {
  it("bounds calls and distinguishes timeout, rejection and 5xx without changing body/key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 422 }))
      .mockResolvedValueOnce(Response.json({ id: randomUUID() }));
    const p = new InviteEmailProvider("re_synthetic", fetcher);
    await expect(p.send("stable-key", '{"test":1}')).rejects.toMatchObject({
      definitive: false,
    });
    await expect(p.send("stable-key", '{"test":1}')).rejects.toMatchObject({
      definitive: false,
    });
    await expect(p.send("stable-key", '{"test":1}')).rejects.toMatchObject({
      definitive: true,
    });
    await expect(p.send("stable-key", '{"test":1}')).resolves.toBeTruthy();
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.body).toBe('{"test":1}');
      expect(new Headers(options?.headers).get("idempotency-key")).toBe(
        "stable-key",
      );
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
