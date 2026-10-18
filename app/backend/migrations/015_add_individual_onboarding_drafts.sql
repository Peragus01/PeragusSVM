-- Synthetic-data staging drafts only; no legal identity is stored in plaintext.
create table peragus_individual_onboarding_drafts (
  customer_id uuid primary key references peragus_customers(id),
  environment text not null default 'test' check(environment='test'),
  encrypted_payload jsonb not null check(jsonb_typeof(encrypted_payload)='object' and octet_length(encrypted_payload::text) <= 32768),
  version integer not null default 1 check(version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table peragus_individual_onboarding_drafts enable row level security;
revoke all on peragus_individual_onboarding_drafts from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_individual_onboarding_drafts from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_individual_onboarding_drafts from authenticated';
  end if;
end $$;
