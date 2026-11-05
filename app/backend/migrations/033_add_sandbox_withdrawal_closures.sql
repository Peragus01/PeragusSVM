-- Local archival closure releases only the sandbox concurrency slot.
alter table peragus_sandbox_withdrawal_executions add constraint peragus_execution_closure_owner_key unique(id,withdrawal_request_id,customer_id);
create table peragus_sandbox_withdrawal_closures (
 id uuid primary key,
 execution_id uuid not null unique,
 withdrawal_request_id uuid not null unique,
 customer_id uuid not null,
 operator_user_id uuid not null,
 request_id uuid not null,
 reason varchar(300) not null check(length(trim(reason))>=10 and reason !~ '[[:cntrl:]]'),
 assurance_level text not null default 'aal2' check(assurance_level='aal2'),
 amount_usdt numeric(21,6) not null check(amount_usdt>0),
 stored_observation jsonb not null check(jsonb_typeof(stored_observation)='object' and octet_length(stored_observation::text)<=8192),
 fresh_observation jsonb not null check(jsonb_typeof(fresh_observation)='object' and octet_length(fresh_observation::text)<=8192),
 closed_at timestamptz not null,
 environment text not null default 'test' check(environment='test'),
 unique(operator_user_id,request_id),
 foreign key(execution_id,withdrawal_request_id,customer_id) references peragus_sandbox_withdrawal_executions(id,withdrawal_request_id,customer_id),
 check((stored_observation->>'status'='completed' and stored_observation->>'sourceLegStatus'='completed' and stored_observation->>'destinationLegStatus'='completed') is true),
 check((fresh_observation->>'status'='completed' and fresh_observation->>'sourceLegStatus'='completed' and fresh_observation->>'destinationLegStatus'='completed') is true)
);
create function peragus_guard_sandbox_closure() returns trigger language plpgsql as $$
begin raise exception 'sandbox withdrawal closure audit is append only'; end $$;
create trigger peragus_sandbox_closure_immutable before update or delete on peragus_sandbox_withdrawal_closures
 for each row execute function peragus_guard_sandbox_closure();
create function peragus_guard_closed_sandbox_execution() returns trigger language plpgsql as $$
begin
 if old.closed_at is not null and (tg_op='DELETE' or new is distinct from old) then
  raise exception 'closed sandbox execution is immutable';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger peragus_closed_execution_immutable before update or delete on peragus_sandbox_withdrawal_executions
 for each row execute function peragus_guard_closed_sandbox_execution();
create function peragus_require_sandbox_closure_audit() returns trigger language plpgsql as $$
begin
 if new.closed_at is not null and not exists(select 1 from peragus_sandbox_withdrawal_closures c
  where c.execution_id=new.id and c.withdrawal_request_id=new.withdrawal_request_id and c.customer_id=new.customer_id and c.closed_at=new.closed_at) then
  raise exception 'sandbox execution closure requires matching audit';
 end if;
 return new;
end $$;
create constraint trigger peragus_execution_closure_audited after insert or update on peragus_sandbox_withdrawal_executions
 deferrable initially deferred for each row execute function peragus_require_sandbox_closure_audit();
alter table peragus_sandbox_withdrawal_closures enable row level security;
revoke all on peragus_sandbox_withdrawal_closures from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on peragus_sandbox_withdrawal_closures from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on peragus_sandbox_withdrawal_closures from authenticated; end if;
end $$;
