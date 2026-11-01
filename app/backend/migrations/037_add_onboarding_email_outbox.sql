-- Dedicated test-only notification queue. Never contains identity documents or email bodies.
create table peragus_onboarding_email_outbox (
  id uuid primary key,
  customer_id uuid not null references peragus_customers(id),
  environment text not null default 'test' check(environment='test'),
  outcome text not null check(outcome in ('approved','rejected','action_required')),
  state text not null default 'pending' check(state in ('pending','accepted','blocked','superseded')),
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  resend_id text,
  created_at timestamptz not null default now(),
  unique(customer_id, environment, outcome),
  check ((state='accepted') = (resend_id is not null))
);
create table peragus_onboarding_email_workers (
  owner_user_id uuid primary key,
  heartbeat_at timestamptz not null
);
alter table peragus_onboarding_email_outbox enable row level security;
alter table peragus_onboarding_email_workers enable row level security;
revoke all on peragus_onboarding_email_outbox, peragus_onboarding_email_workers from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_onboarding_email_outbox, peragus_onboarding_email_workers from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_onboarding_email_outbox, peragus_onboarding_email_workers from authenticated';
  end if;
end $$;
