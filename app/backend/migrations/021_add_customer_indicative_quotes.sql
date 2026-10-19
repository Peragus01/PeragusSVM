-- Non-executable test quotes. No settlement, Pix or transfer is created here.
create table peragus_customer_indicative_quotes (
  id uuid primary key,
  customer_id uuid not null references peragus_customer_onboarding_submissions(customer_id),
  environment text not null default 'test' check(environment='test'),
  request_id uuid not null,
  provider_customer_id text not null check(provider_customer_id ~ '^ozav_cus_[A-Za-z0-9_]+$'),
  source_amount_brl numeric(7,2) not null check(source_amount_brl>0 and source_amount_brl<=10000),
  create_attempted boolean not null default false,
  provider_quote_id text unique check(provider_quote_id ~ '^ozav_q_[A-Za-z0-9_]+$'),
  observation jsonb check(observation is null or (jsonb_typeof(observation)='object' and octet_length(observation::text)<=8192)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(customer_id,request_id),
  check((provider_quote_id is null and observation is null) or (provider_quote_id is not null and observation is not null and create_attempted))
);
alter table peragus_customer_indicative_quotes enable row level security;
revoke all on peragus_customer_indicative_quotes from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_customer_indicative_quotes from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_customer_indicative_quotes from authenticated';
  end if;
end $$;
