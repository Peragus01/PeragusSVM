-- Possession of a test wallet is separate from authentication and financial approval.
create table peragus_customer_wallet_challenges (
  customer_id uuid primary key references peragus_customers(id),
  id uuid not null unique,
  environment text not null default 'test' check(environment='test'),
  wallet_address varchar(44) not null check(wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  nonce varchar(64) not null unique,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check(expires_at > issued_at and expires_at <= issued_at + interval '5 minutes'),
  check(consumed_at is null or consumed_at >= issued_at)
);
create table peragus_customer_wallets (
  customer_id uuid primary key references peragus_customers(id),
  environment text not null default 'test' check(environment='test'),
  network text not null default 'solana:devnet' check(network='solana:devnet'),
  wallet_address varchar(44) not null unique check(wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  proof_challenge_id uuid not null unique,
  proof_message varchar(2048) not null,
  proof_signature varchar(88) not null,
  verified_at timestamptz not null
);
alter table peragus_customer_wallet_challenges enable row level security;
alter table peragus_customer_wallets enable row level security;
revoke all on peragus_customer_wallet_challenges,peragus_customer_wallets from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on peragus_customer_wallet_challenges,peragus_customer_wallets from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on peragus_customer_wallet_challenges,peragus_customer_wallets from authenticated';
  end if;
end $$;
