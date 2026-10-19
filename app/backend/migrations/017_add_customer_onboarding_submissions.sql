-- Form-based synthetic sandbox registration, separate from diagnostic fixtures.
create table peragus_customer_onboarding_submissions (
  id uuid primary key,
  customer_id uuid not null unique references peragus_customers(id),
  environment text not null default 'test' check(environment='test'),
  draft_version integer not null check(draft_version>0),
  terms_session_id uuid not null references peragus_customer_terms_sessions(id),
  request_hash char(64) not null check(request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique,
  encrypted_payload jsonb not null check(jsonb_typeof(encrypted_payload)='object' and octet_length(encrypted_payload::text)<=32768),
  state text not null default 'pending' check(state in ('pending','linked')),
  provider_customer_id text unique check(provider_customer_id ~ '^ozav_cus_[A-Za-z0-9_]+$'),
  provider_status text,
  verification_mode text check(verification_mode in ('full','reliance')),
  provider_snapshot jsonb check(provider_snapshot is null or jsonb_typeof(provider_snapshot)='object'),
  snapshot_version integer not null default 0 check(snapshot_version>=0),
  refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((state='pending' and provider_customer_id is null) or (state='linked' and provider_customer_id is not null))
);
alter table peragus_customer_onboarding_submissions enable row level security;
revoke all on peragus_customer_onboarding_submissions from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_customer_onboarding_submissions from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_customer_onboarding_submissions from authenticated';
  end if;
end $$;
