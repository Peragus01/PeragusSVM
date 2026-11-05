import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { InviteEmailCipher } from "./invite-email-cipher.js";
import { InviteProviderError } from "./invite-email-provider.js";

export interface InviteDeliveryProvider {
  send(key: string, body: string): Promise<string>;
  status(id: string): Promise<string | null>;
}
/** Requires a dedicated SESSION-mode connection, never Supabase transaction pooling.
 * Advisory lock coordinates workers; actual row locks coordinate ALL invite mutations.
 * Durable attempt written before HTTP; a crash/ambiguous commit retries the frozen message.
 */
export async function processInviteEmail(
  db: Pick<PoolClient, "query">,
  cipher: InviteEmailCipher,
  provider: InviteDeliveryProvider,
): Promise<boolean> {
  const lock = await db.query(
    "select pg_try_advisory_lock(808613,40) as locked",
  );
  if (!lock.rows[0]?.locked) return false;
  try {
    await db.query(`update peragus_invite_email_outbox o set
      state=case when first_attempt_at is null then 'cancelled' else 'uncertain' end,
      retry_blocked_at=clock_timestamp(),encrypted_payload=null,last_error='INVITE_TERMINAL',updated_at=clock_timestamp()
      from peragus_pilot_invites i where i.id=o.invite_id and o.state in ('pending','sending','uncertain') and o.retry_blocked_at is null
      and (i.state<>'issued' or i.expires_at<=clock_timestamp())`);
    // Resend retains keys for 24h. Stop at 23h to allow for skew/network delay.
    await db.query(`update peragus_invite_email_outbox set state='uncertain',retry_blocked_at=clock_timestamp(),encrypted_payload=null,
      last_error='IDEMPOTENCY_WINDOW_ELAPSED',updated_at=clock_timestamp()
      where state in ('pending','sending','uncertain') and retry_blocked_at is null and first_attempt_at<=clock_timestamp()-interval '23 hours'`);
    const found =
      await db.query(`select invite_id from peragus_invite_email_outbox where environment='test'
      and state in ('pending','sending','uncertain') and retry_blocked_at is null and next_attempt_at<=clock_timestamp()
      order by created_at,invite_id limit 1`);
    const id = found.rows[0]?.invite_id as string | undefined;
    if (!id) {
      const accepted =
        await db.query(`select invite_id,provider_email_id from peragus_invite_email_outbox where environment='test' and state='accepted'
        and (last_checked_at is null or last_checked_at<clock_timestamp()-interval '1 minute') order by last_checked_at nulls first limit 1`);
      const row = accepted.rows[0];
      if (!row) return false;
      const event = await provider.status(row.provider_email_id);
      await db.query(
        `update peragus_invite_email_outbox set last_checked_at=clock_timestamp(),
        state=case when $2 in ('delivered','opened','clicked') then 'delivered' when $2 in ('bounced','complained','failed') then 'failed' else state end,
        delivered_at=case when $2 in ('delivered','opened','clicked') then coalesce(delivered_at,clock_timestamp()) else delivered_at end,
        last_error=case when $2='bounced' then 'BOUNCED' when $2='complained' then 'COMPLAINED' when $2='failed' then 'PROVIDER_FAILED' else last_error end,
        updated_at=clock_timestamp() where invite_id=$1 and state='accepted'`,
        [row.invite_id, event],
      );
      return true;
    }
    // This autocommit survives process death/ROLLBACK after the provider accepts.
    await db.query(
      `update peragus_invite_email_outbox set state='sending',attempt_count=attempt_count+1,
      first_attempt_at=coalesce(first_attempt_at,clock_timestamp()),next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
      where invite_id=$1 and retry_blocked_at is null and state in ('pending','sending','uncertain')`,
      [id],
    );
    await db.query("begin");
    try {
      // Always lock invite BEFORE outbox, matching the terminal-transition trigger.
      const invite = await db.query(
        "select code_hash,state,expires_at>clock_timestamp()+interval '15 seconds' as valid from peragus_pilot_invites where id=$1 for update",
        [id],
      );
      const outbox = await db.query(
        "select * from peragus_invite_email_outbox where invite_id=$1 for update",
        [id],
      );
      const row = outbox.rows[0],
        i = invite.rows[0];
      if (
        !row ||
        row.retry_blocked_at ||
        !["pending", "sending", "uncertain"].includes(row.state)
      ) {
        await db.query("commit");
        return true;
      }
      if (!i || i.state !== "issued" || !i.valid) {
        await db.query(
          `update peragus_invite_email_outbox set state=case when attempt_count=1 then 'cancelled' else 'uncertain' end,
          retry_blocked_at=clock_timestamp(),encrypted_payload=null,last_error='INVITE_EXPIRING',updated_at=clock_timestamp() where invite_id=$1`,
          [id],
        );
        await db.query("commit");
        return true;
      }
      let message: string;
      try {
        const payload = cipher.open(id, row.encrypted_payload);
        const body = JSON.parse(payload.message ?? "") as {
          to?: string;
          html?: string;
          text?: string;
        };
        if (
          createHash("sha256").update(payload.code).digest("hex") !==
            i.code_hash ||
          body.to !== payload.email ||
          !body.html?.includes(payload.code) ||
          !body.text?.includes(payload.code)
        )
          throw Error();
        message = payload.message!;
      } catch {
        await db.query(
          "update peragus_invite_email_outbox set state='failed',encrypted_payload=null,last_error='PAYLOAD_INVALID',updated_at=clock_timestamp() where invite_id=$1",
          [id],
        );
        await db.query("commit");
        return true;
      }
      // Recheck the safety window using the database wall clock after acquiring locks.
      const safe = await db.query(
        "select o.first_attempt_at>clock_timestamp()-interval '23 hours' and i.state='issued' and i.expires_at>clock_timestamp()+interval '15 seconds' as safe from peragus_invite_email_outbox o join peragus_pilot_invites i on i.id=o.invite_id where o.invite_id=$1",
        [id],
      );
      if (!safe.rows[0]?.safe) throw new InviteProviderError(false);
      const providerId = await provider.send(row.idempotency_key, message);
      await db.query(
        `update peragus_invite_email_outbox set state='accepted',provider_email_id=$2,accepted_at=clock_timestamp(),encrypted_payload=null,last_error=null,updated_at=clock_timestamp() where invite_id=$1`,
        [id, providerId],
      );
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      const rejected = error instanceof InviteProviderError && error.definitive;
      await db.query(
        `update peragus_invite_email_outbox set state=case when $2 then 'failed' else 'uncertain' end,
        encrypted_payload=case when $2 then null else encrypted_payload end,last_error=case when $2 then 'PROVIDER_REJECTED' else 'PROVIDER_UNCONFIRMED' end,
        updated_at=clock_timestamp() where invite_id=$1 and retry_blocked_at is null and state in ('pending','sending','uncertain')`,
        [id, rejected],
      );
    }
    return true;
  } finally {
    await db.query("select pg_advisory_unlock(808613,40)");
  }
}
