-- Test-only observations. Completed sandbox checks do not authorize operations.
create table peragus_customer_verifications (
  customer_id uuid primary key references peragus_customer_onboarding_submissions(customer_id),
  environment text not null default 'test' check(environment='test'),
  provider_customer_id text not null unique check(provider_customer_id ~ '^ozav_cus_[A-Za-z0-9_]+$'),
  verification_id text unique check(verification_id ~ '^ozav_vrf_[A-Za-z0-9_]+$'),
  create_attempted boolean not null default false,
  observation jsonb check(observation is null or (jsonb_typeof(observation)='object' and octet_length(observation::text)<=8192)),
  revision integer not null default 0 check(revision>=0),
  last_simulated_outcome text check(last_simulated_outcome in ('approved','rejected')),
  refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((verification_id is null and observation is null) or (verification_id is not null and observation is not null))
);
alter table peragus_customer_verifications enable row level security;
revoke all on peragus_customer_verifications from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_customer_verifications from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_customer_verifications from authenticated';
  end if;
end $$;
