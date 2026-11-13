-- Purchase progression from OZAV transfer state (Task 8). Not applied to any
-- environment before this version.
--
-- New transition edges (mirrors canTransition in src/purchases/operation-status.ts;
-- a test compares every pair):
--  * accepted -> needs_review: a live Pix whose create was ambiguous is recovered
--    by GET, but the FX lock outcome exists only on the create response.
--  * needs_review -> pix_confirmed / converted: OZAV's own needs_review is
--    non-terminal; progression resumes only from reason OZAV_TRANSFER_NEEDS_REVIEW.
--  * expired -> refund_pending, failed -> refund_pending: only by an operator refund
--    decision and only when the Pix source leg is confirmed paid. The decision service
--    checks it under the row lock; the status guard below refuses it otherwise.
-- CREATE OR REPLACE keeps the privileges revoked by 045.
create or replace function peragus_operation_can_transition(from_status text, to_status text) returns boolean
 language sql immutable set search_path = pg_catalog, public as $$
 select exists(select 1 from (values
  ('quoted','accepted'),('quoted','expired'),
  ('accepted','awaiting_pix'),('accepted','expired'),('accepted','failed'),('accepted','needs_review'),
  ('awaiting_pix','pix_confirmed'),('awaiting_pix','converted'),('awaiting_pix','expired'),('awaiting_pix','failed'),
  ('awaiting_pix','needs_review'),('awaiting_pix','refund_pending'),
  ('pix_confirmed','converted'),('pix_confirmed','needs_review'),('pix_confirmed','refund_pending'),
  ('converted','awaiting_approval'),('converted','needs_review'),('converted','refund_pending'),
  ('awaiting_approval','approved'),('awaiting_approval','needs_review'),('awaiting_approval','refund_pending'),
  ('approved','sending'),('approved','needs_review'),
  ('sending','sent'),('sending','needs_review'),
  ('sent','delivered_verified'),('sent','needs_review'),
  ('needs_review','pix_confirmed'),('needs_review','converted'),('needs_review','awaiting_approval'),
  ('needs_review','refund_pending'),('needs_review','failed'),
  ('refund_pending','refunded'),('refund_pending','needs_review'),
  ('expired','refund_pending'),('failed','refund_pending')
 ) t(f,t) where t.f=from_status and t.t=to_status)
$$;

-- Same guard as 045, plus: a closed (expired/failed) operation reopens as
-- refund_pending only when its Pix source leg is recorded as completed (paid).
create or replace function peragus_purchase_status_guard() returns trigger language plpgsql
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
  if old.status in ('expired','failed') and not exists(select 1 from public.peragus_customer_sandbox_pix x
    where x.purchase_intent_id=new.id and x.customer_id=new.customer_id and x.environment=new.environment
     and x.observation->>'sourceLegStatus'='completed') then
   raise exception 'OPERATION_INVALID_TRANSITION';
  end if;
  new.status_changed_at := now();
 else
  new.status_changed_at := old.status_changed_at;
 end if;
 return new;
end $$;

-- Operator refund decisions (append-only audit; idempotent per operator + request_id).
create table peragus_operator_refund_decisions (
 id uuid primary key,
 purchase_id uuid not null,
 customer_id uuid not null,
 operator_user_id uuid not null,
 request_id uuid not null,
 reason varchar(500) not null check(length(trim(reason))>=10 and reason !~ '[[:cntrl:]]'),
 from_status text not null,
 environment text not null constraint peragus_row_environment_check check(environment in ('test','live')),
 created_at timestamptz not null default now(),
 unique(operator_user_id,request_id),
 foreign key(purchase_id,customer_id) references peragus_customer_purchase_intents(id,customer_id)
);
create index peragus_operator_refund_decisions_purchase on peragus_operator_refund_decisions(purchase_id);
alter table peragus_operator_refund_decisions enable row level security;
revoke all on peragus_operator_refund_decisions from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_operator_refund_decisions from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_operator_refund_decisions from authenticated'; end if;
end $$;
create trigger peragus_row_environment_guard before insert or update on peragus_operator_refund_decisions
 for each row execute function peragus_enforce_row_environment();
create function peragus_operator_refund_decisions_append_only() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin raise exception 'OPERATOR_REFUND_DECISIONS_APPEND_ONLY'; end $$;
create trigger peragus_operator_refund_decisions_immutable before update or delete on peragus_operator_refund_decisions
 for each row execute function peragus_operator_refund_decisions_append_only();
do $$ declare r text; begin
 execute 'revoke execute on function peragus_operator_refund_decisions_append_only() from public';
 for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
  execute format('revoke execute on function peragus_operator_refund_decisions_append_only() from %I',r);
 end loop;
end $$;
