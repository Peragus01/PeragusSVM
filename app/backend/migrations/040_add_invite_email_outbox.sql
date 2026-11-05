-- Staging-only invitation delivery. Existing invites are deliberately not backfilled.
create table peragus_invite_email_outbox (
  invite_id uuid primary key references peragus_pilot_invites(id),
  environment text not null default 'test' check (environment = 'test'),
  idempotency_key text not null unique,
  encrypted_payload jsonb,
  state text not null default 'pending' check (state in ('pending','sending','accepted','delivered','failed','uncertain','cancelled')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  retry_blocked_at timestamptz,
  last_error text check(last_error in ('PROVIDER_REJECTED','PROVIDER_UNCONFIRMED','PAYLOAD_INVALID','IDEMPOTENCY_WINDOW_ELAPSED','INVITE_TERMINAL','INVITE_EXPIRING','BOUNCED','COMPLAINED','PROVIDER_FAILED')),
  provider_email_id text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state not in ('pending','sending','uncertain') or retry_blocked_at is not null or encrypted_payload is not null),
  check ((state not in ('accepted','delivered')) or (provider_email_id is not null and accepted_at is not null)),
  check (state<>'delivered' or delivered_at is not null),
  check(idempotency_key='peragus-invitation-test/'||invite_id::text)
);
create index peragus_invite_email_pending on peragus_invite_email_outbox(next_attempt_at) where state in ('pending','sending','uncertain') and retry_blocked_at is null;
alter table peragus_invite_email_outbox enable row level security;
revoke all on peragus_invite_email_outbox from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then revoke all on peragus_invite_email_outbox from anon; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on peragus_invite_email_outbox from authenticated; end if;
end $$;
-- The invite row lock is shared by worker, revoke, expiry and redemption UPDATEs.
-- Purge immediately on a terminal transition, even when the worker is offline.
create function peragus_cancel_invite_email() returns trigger language plpgsql as $$
begin
 if new.state<>old.state and new.state<>'issued' then
  update public.peragus_invite_email_outbox set
   state=case when state='pending' then 'cancelled' when state in ('sending','uncertain') then 'uncertain' else state end,
   retry_blocked_at=case when state in ('pending','sending','uncertain') then clock_timestamp() else retry_blocked_at end,
   last_error=case when state in ('pending','sending','uncertain') then 'INVITE_TERMINAL' else last_error end,
   encrypted_payload=null,updated_at=clock_timestamp() where invite_id=new.id;
 end if;
 return new;
end $$;
revoke all on function peragus_cancel_invite_email() from public;
create trigger peragus_invite_email_terminal after update on peragus_pilot_invites for each row execute function peragus_cancel_invite_email();
-- Identity and the exact encrypted message cannot change between retries.
create function peragus_guard_invite_email() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'invite email audit cannot be deleted'; end if;
 if (new.invite_id,new.environment,new.idempotency_key,new.created_at) is distinct from
    (old.invite_id,old.environment,old.idempotency_key,old.created_at)
    or (new.encrypted_payload is distinct from old.encrypted_payload and new.encrypted_payload is not null)
    or (old.first_attempt_at is not null and new.first_attempt_at is distinct from old.first_attempt_at)
    or new.attempt_count<old.attempt_count
    or (old.provider_email_id is not null and new.provider_email_id is distinct from old.provider_email_id)
    or (old.retry_blocked_at is not null and new.retry_blocked_at is null) then
  raise exception 'invite email audit is immutable';
 end if;
 return new;
end $$;
revoke all on function peragus_guard_invite_email() from public;
create trigger peragus_invite_email_guard before update or delete on peragus_invite_email_outbox for each row execute function peragus_guard_invite_email();
