-- Approval audit only. A recorded decision never triggers a provider send.
alter table peragus_customer_withdrawal_requests add constraint peragus_withdrawal_id_owner_key unique(id,customer_id);
create table peragus_withdrawal_operator_approvals (
 id uuid primary key,
 withdrawal_request_id uuid not null unique,
 customer_id uuid not null,
 operator_user_id uuid not null,
 request_id uuid not null,
 environment text not null default 'test' check(environment='test'),
 assurance_level text not null check(assurance_level='aal2'),
 reason varchar(300) not null check(length(trim(reason))>=10 and reason !~ '[[:cntrl:]]'),
 amount_usdt numeric(21,6) not null check(amount_usdt>0),
 wallet_address varchar(44) not null,
 created_at timestamptz not null default now(),
 unique(operator_user_id,request_id),
 foreign key(withdrawal_request_id,customer_id) references peragus_customer_withdrawal_requests(id,customer_id)
);
alter table peragus_withdrawal_operator_approvals enable row level security;
revoke all on peragus_withdrawal_operator_approvals from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_withdrawal_operator_approvals from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_withdrawal_operator_approvals from authenticated'; end if;
end $$;

create function peragus_reject_withdrawal_approval_mutation() returns trigger language plpgsql as $$
begin
 raise exception 'Withdrawal operator approvals are append-only';
end;
$$;
create trigger peragus_withdrawal_approval_immutable before update or delete
 on peragus_withdrawal_operator_approvals for each row
 execute function peragus_reject_withdrawal_approval_mutation();
