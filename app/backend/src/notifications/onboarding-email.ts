import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import type { Customer } from "../auth/customer-access.js";
import type { OverviewFacts } from "../onboarding/customer-onboarding-overview.js";
import {
  notificationMessage,
  noticeOutcome,
  onboardingReview,
} from "./onboarding-result.js";
import type { EmailMessage } from "./resend.js";

export async function emailNotificationReady(
  pool: Pool,
  owner: string,
): Promise<boolean> {
  const result = await pool.query(
    `select 1 from peragus_onboarding_email_workers w
    join auth.users u on u.id=w.owner_user_id
    where w.owner_user_id=$1 and w.heartbeat_at > now()-interval '180 seconds'
      and u.email_confirmed_at is not null and u.email is not null`,
    [owner],
  );
  return result.rows.length === 1;
}
export class OnboardingEmailProcessor {
  constructor(
    private readonly db: Pick<PoolClient, "query">,
    private readonly sender: {
      send(id: string, message: EmailMessage): Promise<string>;
    },
    private readonly from: string,
    private readonly accountUrl: string,
    private readonly readFresh: (customer: Customer) => Promise<OverviewFacts>,
    mode: MoneyMode,
  ) {
    this.e = rowEnvironment(mode);
  }
  private readonly e: RowEnvironment;
  async process(customer: Customer, email: string): Promise<void> {
    // Caller supplies a verified Auth address, never a browser-selected recipient.
    const facts = await this.readFresh(customer);
    const outcome = noticeOutcome(onboardingReview(facts));
    await this.db.query(
      `update peragus_onboarding_email_outbox set state='superseded'
      where customer_id=$1 and state='pending' and outcome is distinct from $2`,
      [customer.id, outcome],
    );
    if (!outcome) return;
    const message: EmailMessage = {
      from: this.from,
      to: email,
      ...notificationMessage(outcome, this.accountUrl),
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(message))
      .digest("hex");
    await this.db.query(
      `insert into peragus_onboarding_email_outbox(id,customer_id,outcome,payload_hash,environment)
      values($1,$2,$3,$4,$5) on conflict(customer_id,environment,outcome) do nothing`,
      [randomUUID(), customer.id, outcome, hash, this.e.mode],
    );
    // Persist attempt time BEFORE contacting Resend. A crash can safely retry only within its 24h idempotency window.
    const claim = await this.db.query<{ id: string }>(
      `update peragus_onboarding_email_outbox
      set first_attempt_at=coalesce(first_attempt_at,now()),next_attempt_at=now()+interval '5 minutes'
      where customer_id=$1 and outcome=$2 and state='pending' and payload_hash=$3
      and next_attempt_at<=now() and (first_attempt_at is null or first_attempt_at>now()-interval '23 hours') returning id`,
      [customer.id, outcome, hash],
    );
    await this.db.query(
      `update peragus_onboarding_email_outbox set state='blocked'
      where customer_id=$1 and outcome=$2 and state='pending'
      and (payload_hash<>$3 or first_attempt_at<=now()-interval '23 hours')`,
      [customer.id, outcome, hash],
    );
    const row = claim.rows[0];
    if (!row) return;
    const resendId = await this.sender.send(row.id, message);
    await this.db.query(
      "update peragus_onboarding_email_outbox set state='accepted',resend_id=$2 where id=$1 and state='pending'",
      [row.id, resendId],
    );
  }
}
