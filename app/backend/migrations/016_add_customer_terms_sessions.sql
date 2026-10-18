-- Test-only terms intents and encrypted one-time tokens/evidence. No raw identity.
create table peragus_customer_terms_sessions (
  id uuid primary key,
  customer_id uuid not null references peragus_customers(id),
  environment text not null default 'test' check(environment='test'),
  active boolean not null default true,
  state text not null default 'creating' check(state in ('creating','ready','accepting','accepted','uncertain')),
  idempotency_key text not null unique,
  generation integer not null default 1 check(generation>0),
  lease_until timestamptz not null,
  encrypted_token jsonb check(encrypted_token is null or (jsonb_typeof(encrypted_token)='object' and octet_length(encrypted_token::text)<=16384)),
  terms_url text,
  terms_version varchar(80),
  expires_at timestamptz,
  encrypted_acceptance jsonb check(encrypted_acceptance is null or (jsonb_typeof(encrypted_acceptance)='object' and octet_length(encrypted_acceptance::text)<=16384)),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(state in ('creating','uncertain') or (encrypted_token is not null and terms_url is not null and terms_version is not null and expires_at is not null)),
  check(state not in ('accepting','accepted') or encrypted_acceptance is not null),
  check(state<>'accepted' or accepted_at is not null)
);
create unique index peragus_customer_terms_active_idx on peragus_customer_terms_sessions(customer_id) where active;
alter table peragus_customer_terms_sessions enable row level security;
revoke all on peragus_customer_terms_sessions from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_customer_terms_sessions from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_customer_terms_sessions from authenticated';
  end if;
end $$;
