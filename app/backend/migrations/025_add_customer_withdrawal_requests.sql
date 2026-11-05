-- Historical, record-only withdrawal requests. No send, approval or reservation of funds.
alter table peragus_customer_sandbox_pix add constraint peragus_pix_purchase_owner_key unique(id,purchase_intent_id,customer_id);
create table peragus_customer_withdrawal_requests (
 id uuid primary key,
 customer_id uuid not null,
 request_id uuid not null,
 pix_id uuid not null unique,
 purchase_intent_id uuid not null unique,
 environment text not null default 'test' check(environment='test'),
 state text not null default 'recorded' check(state='recorded'),
 record_only boolean not null default true check(record_only),
 provider_customer_id text not null,
 provider_wallet_id text not null,
 provider_transfer_id text not null unique,
 amount_usdt numeric(21,6) not null check(amount_usdt>0),
 currency text not null default 'USDT' check(currency='USDT'),
 wallet_address varchar(44) not null check(wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 proof_network text not null default 'solana:devnet' check(proof_network='solana:devnet'),
 wallet_verified_at timestamptz not null,
 evidence_snapshot jsonb not null check(jsonb_typeof(evidence_snapshot)='object' and octet_length(evidence_snapshot::text)<=8192),
 created_at timestamptz not null default now(),
 unique(customer_id,request_id),
 foreign key(pix_id,purchase_intent_id,customer_id) references peragus_customer_sandbox_pix(id,purchase_intent_id,customer_id),
 foreign key(purchase_intent_id,customer_id) references peragus_customer_purchase_intents(id,customer_id)
);
alter table peragus_customer_withdrawal_requests enable row level security;
revoke all on peragus_customer_withdrawal_requests from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_customer_withdrawal_requests from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_customer_withdrawal_requests from authenticated'; end if;
end $$;
