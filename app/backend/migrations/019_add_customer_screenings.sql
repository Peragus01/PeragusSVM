-- Point-in-time, test-only screening evidence; never authorizes operations.
create table peragus_customer_screenings (
  customer_id uuid primary key references peragus_customer_onboarding_submissions(customer_id),
  environment text not null default 'test' check(environment='test'),
  provider_customer_id text not null unique check(provider_customer_id ~ '^ozav_cus_[A-Za-z0-9_]+$'),
  idempotency_key text not null unique,
  screening_id text unique check(screening_id ~ '^ozav_scr_[A-Za-z0-9_]+$'),
  observation jsonb check(observation is null or (jsonb_typeof(observation)='object' and octet_length(observation::text)<=8192)),
  revision integer not null default 0 check(revision>=0),
  refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((screening_id is null and observation is null) or (screening_id is not null and observation is not null))
);
alter table peragus_customer_screenings enable row level security;
revoke all on peragus_customer_screenings from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_customer_screenings from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_customer_screenings from authenticated';
  end if;
end $$;
