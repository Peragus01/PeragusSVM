-- Final review fixes (Rulings 38-40). Not applied to any environment before this version.
--
-- * needs_review -> delivered_verified: an operator re-runs the on-chain delivery check
--   (Ruling 39) of an operation that entered review from `sent`. The status guard refuses
--   it from any other review.
-- * peragus_sandbox_withdrawal_executions.refused_find_clear_at: a GET-only metadata find for
--   a definitively refused send returned no transfer (Ruling 38 lets the refund decision
--   through only then).
-- * Manual refund decisions: an approval may supersede an earlier rejection of the same
--   refund request (audited, append-only); the current decision is the one not superseded.
-- * peragus_operator_resolutions: audited, fresh-MFA operator resolutions (Ruling 39).
-- * Operator notification kinds: 'awaiting_approval' (customer paid, approve) and
--   'operator_resolution'.
-- * peragus_worker_heartbeats: the worker beats every minute; /ready fails when stale.

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
  ('needs_review','refund_pending'),('needs_review','failed'),('needs_review','delivered_verified'),
  ('refund_pending','refunded'),('refund_pending','needs_review'),
  ('expired','refund_pending'),('failed','refund_pending')
 ) t(f,t) where t.f=from_status and t.t=to_status)
$$;

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
  -- A delivery is verified out of review only when the review was entered from `sent`.
  if old.status='needs_review' and new.status='delivered_verified' and coalesce((select e.from_status
    from public.peragus_operation_status_events e where e.purchase_id=new.id and e.from_status is distinct from e.to_status
    order by e.id desc limit 1),'')<>'sent' then
   raise exception 'OPERATION_INVALID_TRANSITION';
  end if;
  new.status_changed_at := now();
 else
  new.status_changed_at := old.status_changed_at;
 end if;
 return new;
end $$;

alter table peragus_sandbox_withdrawal_executions
 add column refused_find_clear_at timestamptz,
 add constraint peragus_execution_refused_find_clear check(refused_find_clear_at is null
  or (provider_refusal_code is not null and refused_transfer_id is null));

-- Superseding approvals (refund_pending with a legacy rejection).
do $$ declare c text; begin
 for c in select con.conname from pg_constraint con join pg_attribute a on a.attrelid=con.conrelid and a.attnum=con.conkey[1]
  where con.conrelid='public.peragus_manual_refund_decisions'::regclass and con.contype='u'
   and array_length(con.conkey,1)=1 and a.attname='refund_request_id' loop
  execute format('alter table public.peragus_manual_refund_decisions drop constraint %I',c);
 end loop;
end $$;
alter table peragus_manual_refund_decisions
 add column supersedes_decision_id uuid unique references peragus_manual_refund_decisions(id),
 add constraint peragus_refund_decision_supersedes_approval check(supersedes_decision_id is null or decision='approved');
create unique index peragus_manual_refund_one_original_decision on peragus_manual_refund_decisions(refund_request_id)
 where supersedes_decision_id is null;
create function peragus_manual_refund_supersede_guard() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 if new.supersedes_decision_id is not null and not exists(select 1 from public.peragus_manual_refund_decisions d
   where d.id=new.supersedes_decision_id and d.refund_request_id=new.refund_request_id and d.decision='rejected') then
  raise exception 'REFUND_DECISION_SUPERSEDE_INVALID';
 end if;
 return new;
end $$;
create trigger peragus_manual_refund_supersede_guard before insert on peragus_manual_refund_decisions
 for each row execute function peragus_manual_refund_supersede_guard();

-- Operator resolutions (Ruling 39): append-only audit, idempotent per operator + request_id.
create table peragus_operator_resolutions (
 id uuid primary key,
 purchase_id uuid not null,
 customer_id uuid not null,
 operator_user_id uuid not null,
 request_id uuid not null,
 action text not null check(action in ('close_unpaid_review','reverify_delivery','return_approved_to_review')),
 reason varchar(500) not null check(length(trim(reason))>=10 and reason !~ '[[:cntrl:]]'),
 from_status text not null,
 to_status text not null,
 outcome text not null check(length(outcome) between 1 and 200 and outcome !~ '[[:cntrl:]]'),
 environment text not null constraint peragus_row_environment_check check(environment in ('test','live')),
 created_at timestamptz not null default now(),
 unique(operator_user_id,request_id),
 foreign key(purchase_id,customer_id) references peragus_customer_purchase_intents(id,customer_id)
);
create index peragus_operator_resolutions_purchase on peragus_operator_resolutions(purchase_id,created_at);
alter table peragus_operator_resolutions enable row level security;
revoke all on peragus_operator_resolutions from public;
create trigger peragus_row_environment_guard before insert or update on peragus_operator_resolutions
 for each row execute function peragus_enforce_row_environment();
create function peragus_operator_resolutions_append_only() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin raise exception 'OPERATOR_RESOLUTIONS_APPEND_ONLY'; end $$;
create trigger peragus_operator_resolutions_immutable before update or delete on peragus_operator_resolutions
 for each row execute function peragus_operator_resolutions_append_only();
create function peragus_notify_operator_resolution() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 perform public.peragus_enqueue_operator_notification(new.environment,'operator_resolution','warn',
  'operator_resolution:'||new.id::text,new.purchase_id,public.peragus_operator_notification_purchase(new.purchase_id)||
  jsonb_build_object('action',new.action,'from_status',new.from_status,'to_status',new.to_status,
   'reason_code',substring(new.outcome from '^[A-Z][A-Z0-9_]{2,63}'),'event_at',new.created_at));
 return null;
end $$;
create trigger peragus_notify_operator_resolution after insert on peragus_operator_resolutions
 for each row execute function peragus_notify_operator_resolution();

-- New notification kinds.
do $$ declare c text; begin
 for c in select con.conname from pg_constraint con join pg_attribute a on a.attrelid=con.conrelid and a.attnum=con.conkey[1]
  where con.conrelid='public.peragus_operator_notifications'::regclass and con.contype='c'
   and array_length(con.conkey,1)=1 and a.attname='kind' loop
  execute format('alter table public.peragus_operator_notifications drop constraint %I',c);
 end loop;
end $$;
alter table peragus_operator_notifications add constraint peragus_operator_notifications_kind_check check(kind in ('approval','execution',
 'needs_review','refund_pending','refund_completed','operator_refund_decision','runtime_control_changed','stuck_operation',
 'webhook_signature_invalid','reconciliation_mismatch','pix_open_after_close','withdrawal_refused_transfer_found',
 'daily_review_missing','awaiting_approval','operator_resolution'));

-- Status transitions; adds awaiting_approval ("cliente pagou — aprovar").
create or replace function peragus_notify_operation_status_event() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
declare k text; sev text; key text;
begin
 if new.from_status is not distinct from new.to_status then return null; end if;
 k := case new.to_status when 'approved' then 'approval' when 'sending' then 'execution' when 'delivered_verified' then 'execution'
  when 'needs_review' then 'needs_review' when 'refund_pending' then 'refund_pending' when 'awaiting_approval' then 'awaiting_approval' end;
 if k is null then return null; end if;
 sev := case k when 'needs_review' then 'high' when 'refund_pending' then 'warn' when 'awaiting_approval' then 'warn' else 'info' end;
 key := case when k='refund_pending'
  then 'refund_pending:'||new.purchase_id::text||':'||(select count(*) from public.peragus_operation_status_events e
   where e.purchase_id=new.purchase_id and e.to_status='refund_pending' and e.from_status is distinct from e.to_status)::text
  else 'status_event:'||new.id::text end;
 perform public.peragus_enqueue_operator_notification(new.environment,k,sev,key,new.purchase_id,
  public.peragus_operator_notification_purchase(new.purchase_id)||jsonb_build_object('from_status',new.from_status,'to_status',new.to_status,
   'reason_code',substring(new.reason from '^[A-Z][A-Z0-9_]{2,63}'),'event_at',new.created_at));
 return null;
end $$;

-- KYC (final review I10): a hosted session that expired may be replaced; the ended
-- verification ids stay on the row as history and are never recovered again.
alter table peragus_customer_verifications add column previous_verification_ids text[] not null default '{}';

-- Worker liveness (checked by /ready).
create table peragus_worker_heartbeats (
 worker text not null check(worker ~ '^[a-z][a-z0-9_-]{0,39}$'),
 environment text not null check(environment in ('test','live')),
 beat_at timestamptz not null default now(),
 primary key(worker,environment)
);
alter table peragus_worker_heartbeats enable row level security;
revoke all on peragus_worker_heartbeats from public;

do $$ declare f text; r text; begin
 foreach f in array array['peragus_manual_refund_supersede_guard()','peragus_operator_resolutions_append_only()',
  'peragus_notify_operator_resolution()'] loop
  execute format('revoke execute on function %s from public',f);
  for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
   execute format('revoke execute on function %s from %I',f,r);
  end loop;
 end loop;
 for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
  execute format('revoke all on peragus_operator_resolutions from %I',r);
  execute format('revoke all on peragus_worker_heartbeats from %I',r);
 end loop;
end $$;
