-- Explicit purchase operation lifecycle (mirrors src/purchases/operation-status.ts).
-- Purchases are created at 'accepted'; transitions are validated here, every
-- change is appended to peragus_operation_status_events, the accepted financial
-- snapshot is immutable and each customer has at most one open operation.
-- The global open-operation cap (PURCHASE_MAX_OPEN_GLOBAL) is enforced by the
-- repository under a transaction-scoped advisory lock.

create function peragus_operation_can_transition(from_status text, to_status text) returns boolean
 language sql immutable set search_path = pg_catalog, public as $$
 select exists(select 1 from (values
  ('quoted','accepted'),('quoted','expired'),
  ('accepted','awaiting_pix'),('accepted','expired'),('accepted','failed'),
  ('awaiting_pix','pix_confirmed'),('awaiting_pix','converted'),('awaiting_pix','expired'),('awaiting_pix','failed'),
  ('awaiting_pix','needs_review'),('awaiting_pix','refund_pending'),
  ('pix_confirmed','converted'),('pix_confirmed','needs_review'),('pix_confirmed','refund_pending'),
  ('converted','awaiting_approval'),('converted','needs_review'),('converted','refund_pending'),
  ('awaiting_approval','approved'),('awaiting_approval','needs_review'),('awaiting_approval','refund_pending'),
  ('approved','sending'),('approved','needs_review'),
  ('sending','sent'),('sending','needs_review'),
  ('sent','delivered_verified'),('sent','needs_review'),
  ('needs_review','awaiting_approval'),('needs_review','refund_pending'),('needs_review','failed'),
  ('refund_pending','refunded'),('refund_pending','needs_review')
 ) t(f,t) where t.f=from_status and t.t=to_status)
$$;

alter table peragus_customer_purchase_intents
 add column status text not null default 'accepted'
  constraint peragus_purchase_status_check check(status in ('quoted','accepted','awaiting_pix','pix_confirmed','converted',
   'awaiting_approval','approved','sending','sent','delivered_verified','expired','failed','needs_review','refund_pending','refunded')),
 add column status_changed_at timestamptz not null default now();

-- Append-only status log. Holds customer money data, so it carries the row
-- environment and the 043 guard.
create table peragus_operation_status_events (
 id bigint generated always as identity primary key,
 purchase_id uuid not null,
 customer_id uuid not null,
 from_status text check(from_status in ('quoted','accepted','awaiting_pix','pix_confirmed','converted',
  'awaiting_approval','approved','sending','sent','delivered_verified','expired','failed','needs_review','refund_pending','refunded')),
 to_status text not null check(to_status in ('quoted','accepted','awaiting_pix','pix_confirmed','converted',
  'awaiting_approval','approved','sending','sent','delivered_verified','expired','failed','needs_review','refund_pending','refunded')),
 actor text not null check(length(actor) between 1 and 200),
 reason text not null check(length(reason) between 1 and 500),
 environment text not null constraint peragus_row_environment_check check(environment in ('test','live')),
 created_at timestamptz not null default now(),
 foreign key(purchase_id,customer_id) references peragus_customer_purchase_intents(id,customer_id)
);
create index peragus_operation_status_events_purchase on peragus_operation_status_events(purchase_id,id);
alter table peragus_operation_status_events enable row level security;
revoke all on peragus_operation_status_events from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_operation_status_events from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_operation_status_events from authenticated'; end if;
end $$;

create function peragus_operation_status_events_append_only() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin raise exception 'OPERATION_STATUS_EVENTS_APPEND_ONLY'; end $$;
-- Row-level guard like the other append-only logs (029, 036); TRUNCATE is left to
-- the owner role, consistent with them.
create trigger peragus_operation_status_events_immutable before update or delete on peragus_operation_status_events
 for each row execute function peragus_operation_status_events_append_only();

-- Backfill: legacy rows are record-only intents that can never progress, so all
-- of them expire. No legacy row holds open capacity (per customer or global).
-- Legacy rows predate 043 and were all written as 'test'; the row-environment
-- guard is bypassed only for this in-place backfill so a database recorded as
-- 'live' with legacy rows still migrates (the rows keep their own environment
-- and stay invisible to live reads). The event guard is created after it.
alter table peragus_customer_purchase_intents disable trigger peragus_row_environment_guard;
update peragus_customer_purchase_intents set status='expired',status_changed_at=now();
alter table peragus_customer_purchase_intents enable trigger peragus_row_environment_guard;
insert into peragus_operation_status_events(purchase_id,customer_id,from_status,to_status,actor,reason,environment)
 select id,customer_id,null,'expired','system:migration_045','legacy record-only purchase intent expired by migration',environment
 from peragus_customer_purchase_intents order by created_at,id;
create trigger peragus_row_environment_guard before insert or update on peragus_operation_status_events
 for each row execute function peragus_enforce_row_environment();

create unique index peragus_purchase_one_open_per_customer on peragus_customer_purchase_intents(customer_id)
 where status not in ('delivered_verified','expired','failed','refunded');
create index peragus_purchase_open_by_environment on peragus_customer_purchase_intents(environment)
 where status not in ('delivered_verified','expired','failed','refunded');

-- Status guard: inserts start at 'accepted'; updates follow
-- peragus_operation_can_transition and stamp status_changed_at.
create function peragus_purchase_status_guard() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 if tg_op='INSERT' then
  if new.status<>'accepted' then raise exception 'OPERATION_INVALID_TRANSITION'; end if;
  new.status_changed_at := now();
  return new;
 end if;
 if new.status is distinct from old.status then
  if not public.peragus_operation_can_transition(old.status,new.status) then
   raise exception 'OPERATION_INVALID_TRANSITION';
  end if;
  new.status_changed_at := now();
 else
  new.status_changed_at := old.status_changed_at;
 end if;
 return new;
end $$;
create trigger peragus_purchase_status_guard before insert or update on peragus_customer_purchase_intents
 for each row execute function peragus_purchase_status_guard();

-- Accepted financial snapshot is immutable. The trigger arguments are the locked
-- columns: to lock another column, add its name to this list.
create function peragus_purchase_financial_immutable() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
declare i int;
begin
 for i in 0..tg_nargs-1 loop
  -- A misspelled or dropped column must not silently stop being locked.
  if not (to_jsonb(old) ? tg_argv[i]) then
   raise exception 'PURCHASE_LOCKED_COLUMN_UNKNOWN: %', tg_argv[i];
  end if;
  if (to_jsonb(new)->tg_argv[i]) is distinct from (to_jsonb(old)->tg_argv[i]) then
   raise exception 'PURCHASE_FINANCIAL_FIELDS_IMMUTABLE: %', tg_argv[i];
  end if;
 end loop;
 return new;
end $$;
create trigger peragus_purchase_financial_immutable before update on peragus_customer_purchase_intents
 for each row execute function peragus_purchase_financial_immutable(
  'quote_id','customer_id','provider_customer_id','source_amount_brl','estimated_target_amount_usdt',
  'quote_snapshot','wallet_address','wallet_proof_network','wallet_verified_at');

do $$ declare f text; r text; begin
 foreach f in array array['peragus_operation_can_transition(text,text)','peragus_operation_status_events_append_only()',
  'peragus_purchase_status_guard()','peragus_purchase_financial_immutable()'] loop
  execute format('revoke execute on function %s from public',f);
  for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
   execute format('revoke execute on function %s from %I',f,r);
  end loop;
 end loop;
end $$;
