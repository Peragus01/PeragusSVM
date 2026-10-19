-- Immutable, record-only sandbox purchase references; no funding/execution state.
alter table peragus_customer_indicative_quotes
  add constraint peragus_customer_quotes_id_owner_key unique(id,customer_id);
create table peragus_customer_purchase_intents (
  id uuid primary key,
  customer_id uuid not null,
  request_id uuid not null,
  quote_id uuid not null unique,
  environment text not null default 'test' check(environment='test'),
  state text not null default 'recorded' check(state='recorded'),
  record_only boolean not null default true check(record_only),
  provider_customer_id text not null,
  source_amount_brl numeric(7,2) not null check(source_amount_brl>0 and source_amount_brl<=10000),
  estimated_target_amount_usdt numeric(21,6) not null check(estimated_target_amount_usdt>0),
  quote_snapshot jsonb not null check(jsonb_typeof(quote_snapshot)='object' and octet_length(quote_snapshot::text)<=8192),
  wallet_address varchar(44) not null check(wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  wallet_proof_network text not null default 'solana:devnet' check(wallet_proof_network='solana:devnet'),
  wallet_verified_at timestamptz not null,
  evidence_snapshot jsonb not null check(jsonb_typeof(evidence_snapshot)='object' and octet_length(evidence_snapshot::text)<=8192),
  created_at timestamptz not null default now(),
  unique(customer_id,request_id),
  foreign key(quote_id,customer_id) references peragus_customer_indicative_quotes(id,customer_id)
);
alter table peragus_customer_purchase_intents enable row level security;
revoke all on peragus_customer_purchase_intents from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_customer_purchase_intents from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_customer_purchase_intents from authenticated';
  end if;
end $$;
