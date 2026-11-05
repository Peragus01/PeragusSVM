-- Sandbox-only send boundary, with one durable unresolved pilot slot.
alter table peragus_withdrawal_operator_approvals add constraint peragus_approval_execution_binding_key unique(id,withdrawal_request_id,customer_id);
create table peragus_sandbox_withdrawal_executions (
 id uuid primary key,
 withdrawal_request_id uuid not null unique,
 customer_id uuid not null,
 approval_id uuid not null unique,
 approver_id uuid not null,
 operator_id uuid not null,
 request_id uuid not null,
 environment text not null default 'test' check(environment='test'),
 pix_id uuid not null,
 provider_customer_id text not null,
 provider_wallet_id text not null,
 provider_quote_id text not null,
 funding_transfer_id text not null,
 amount_brl numeric(7,2) not null,
 amount_usdt numeric(21,6) not null check(amount_usdt>0),
 wallet_address varchar(44) not null,
 verified_at timestamptz not null,
 network text not null default 'solana' check(network='solana'),
 idempotency_key text not null unique check(idempotency_key='peragus-send-'||id::text),
 create_attempted boolean not null default false,
 provider_send_id text unique,
 observation jsonb check(observation is null or (jsonb_typeof(observation)='object' and octet_length(observation::text)<=8192)),
 pilot_slot smallint not null default 1 check(pilot_slot=1),
 closed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(operator_id,request_id),
 foreign key(withdrawal_request_id,customer_id) references peragus_customer_withdrawal_requests(id,customer_id),
 foreign key(approval_id,withdrawal_request_id,customer_id) references peragus_withdrawal_operator_approvals(id,withdrawal_request_id,customer_id),
 check(provider_send_id is null or create_attempted),
 check(observation is null or (provider_send_id is not null and create_attempted))
);
create unique index peragus_one_unresolved_sandbox_withdrawal on peragus_sandbox_withdrawal_executions(pilot_slot) where closed_at is null;
alter table peragus_sandbox_withdrawal_executions enable row level security;
revoke all on peragus_sandbox_withdrawal_executions from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_sandbox_withdrawal_executions from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_sandbox_withdrawal_executions from authenticated'; end if;
end $$;
