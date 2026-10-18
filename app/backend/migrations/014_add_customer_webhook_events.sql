-- Test-only webhook receipts. No raw event bodies or legal identity data.
create table peragus_customer_webhook_events (
  event_id text primary key check (event_id ~ '^ozav_evt_[A-Za-z0-9_]{1,160}$'),
  environment text not null default 'test' check (environment = 'test'),
  payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  event_type varchar(100) not null,
  disposition text not null default 'processing' check (disposition in ('processing','processed','ignored')),
  received_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table peragus_customer_webhook_events enable row level security;
revoke all on peragus_customer_webhook_events from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_customer_webhook_events from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_customer_webhook_events from authenticated';
  end if;
end $$;
