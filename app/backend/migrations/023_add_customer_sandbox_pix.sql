-- Separate from immutable record-only purchase intents. Sandbox only.
alter table peragus_customer_purchase_intents add constraint peragus_purchase_id_owner_key unique(id,customer_id);
create table peragus_customer_sandbox_pix (
 id uuid primary key,
 customer_id uuid not null,
 request_id uuid not null,
 purchase_intent_id uuid not null unique,
 environment text not null default 'test' check(environment='test'),
 provider_customer_id text not null,
 provider_quote_id text not null,
 source_amount_brl numeric(7,2) not null check(source_amount_brl>=1000 and source_amount_brl<=10000),
 wallet_address varchar(44) not null,
 provider_wallet_id text not null,
 idempotency_key text not null unique,
 create_attempted boolean not null default false,
 provider_transfer_id text unique,
 observation jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(customer_id,request_id),
 foreign key(purchase_intent_id,customer_id) references peragus_customer_purchase_intents(id,customer_id),
 check(observation is null or (provider_transfer_id is not null and create_attempted and jsonb_typeof(observation)='object' and octet_length(observation::text)<=32768))
);
alter table peragus_customer_sandbox_pix enable row level security;
revoke all on peragus_customer_sandbox_pix from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_customer_sandbox_pix from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_customer_sandbox_pix from authenticated'; end if;
end $$;
