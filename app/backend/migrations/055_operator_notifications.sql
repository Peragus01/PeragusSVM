-- Operator alerts, trusted-person e-mails and the daily review (Task 17). Not applied to
-- any environment before this version.
--
-- peragus_operator_notifications is an e-mail outbox (the invite outbox pattern, 040/041):
-- one row per (event, recipient role). Recipient addresses are never stored: the worker
-- resolves 'operator' / 'trusted' from OPERATOR_ALERT_EMAIL / TRUSTED_ALERT_EMAIL. The
-- payload holds operation ids, kinds, statuses and amounts only, never customer personal
-- data. Its Idempotency-Key is stable per row (= per notification and recipient); the
-- attempt is recorded before the HTTP call and an ambiguous outcome ends as 'uncertain',
-- never retried automatically.
--
-- Money-relevant events are enqueued by AFTER INSERT triggers on their own audit rows, so
-- the outbox row commits or rolls back with the status transition / decision / control
-- change that caused it. Time-based thresholds (stuck, overdue) are derived by the
-- periodic scanner (src/jobs/stuck-operations.ts) through the same enqueue function; a
-- (environment, dedupe_key, recipient) unique key makes every enqueue idempotent.
create table peragus_operator_notifications (
 id uuid primary key,
 environment text not null constraint peragus_row_environment_check check(environment in ('test','live')),
 kind text not null check(kind in ('approval','execution','needs_review','refund_pending','refund_completed',
  'operator_refund_decision','runtime_control_changed','stuck_operation','webhook_signature_invalid',
  'reconciliation_mismatch','pix_open_after_close','withdrawal_refused_transfer_found','daily_review_missing')),
 severity text not null check(severity in ('info','warn','high')),
 recipient text not null check(recipient in ('operator','trusted')),
 dedupe_key text not null check(length(dedupe_key) between 1 and 200 and dedupe_key !~ '[[:cntrl:]]'),
 purchase_id uuid,
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
 idempotency_key text not null unique,
 status text not null default 'pending' check(status in ('pending','sending','accepted','failed','uncertain')),
 attempts integer not null default 0 check(attempts between 0 and 1),
 first_attempt_at timestamptz,
 last_error text check(last_error in ('PROVIDER_REJECTED','PROVIDER_UNCONFIRMED','PAYLOAD_INVALID','EXPIRED_UNSENT','RECIPIENT_UNCONFIGURED')),
 provider_email_id text check(provider_email_id ~ '^[a-zA-Z0-9-]{1,100}$'),
 accepted_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(environment,dedupe_key,recipient),
 check(idempotency_key='peragus-operator-notification-'||environment||'/'||id::text),
 check(status<>'accepted' or (provider_email_id is not null and accepted_at is not null)),
 check(status='pending' or status='failed' or attempts=1)
);
create index peragus_operator_notifications_pending on peragus_operator_notifications(environment,created_at,id) where status='pending';
create index peragus_operator_notifications_sending on peragus_operator_notifications(environment,updated_at) where status='sending';

-- Daily review: the operator confirms, per calendar day (America/Sao_Paulo), that the
-- day's operations were reviewed. Append-only; one row per (day, environment).
create table peragus_daily_reviews (
 day date not null,
 environment text not null constraint peragus_row_environment_check check(environment in ('test','live')),
 reviewed_by uuid not null,
 reviewed_at timestamptz not null default now(),
 note varchar(500) check(note is null or (length(trim(note)) between 1 and 500 and note !~ '[[:cntrl:]]')),
 primary key(day,environment)
);

alter table peragus_operator_notifications enable row level security;
alter table peragus_daily_reviews enable row level security;
revoke all on peragus_operator_notifications from public;
revoke all on peragus_daily_reviews from public;
do $$ declare r text; begin
 for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
  execute format('revoke all on peragus_operator_notifications from %I',r);
  execute format('revoke all on peragus_daily_reviews from %I',r);
 end loop;
end $$;

create trigger peragus_row_environment_guard before insert or update on peragus_operator_notifications
 for each row execute function peragus_enforce_row_environment();
create trigger peragus_row_environment_guard before insert or update on peragus_daily_reviews
 for each row execute function peragus_enforce_row_environment();

-- Outbox audit: never deleted; identity, payload and the first attempt are frozen; the
-- status only moves forward (pending -> sending -> accepted|failed|uncertain, or
-- pending -> failed when expired/invalid before any attempt).
create function peragus_operator_notifications_guard() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 if tg_op='DELETE' then raise exception 'OPERATOR_NOTIFICATIONS_IMMUTABLE'; end if;
 if (new.id,new.environment,new.kind,new.severity,new.recipient,new.dedupe_key,new.purchase_id,new.payload,new.payload_hash,new.idempotency_key,new.created_at)
    is distinct from (old.id,old.environment,old.kind,old.severity,old.recipient,old.dedupe_key,old.purchase_id,old.payload,old.payload_hash,old.idempotency_key,old.created_at)
    or new.attempts<old.attempts
    or (old.first_attempt_at is not null and new.first_attempt_at is distinct from old.first_attempt_at)
    or (old.provider_email_id is not null and new.provider_email_id is distinct from old.provider_email_id)
    or (new.status is distinct from old.status and not (
     (old.status='pending' and new.status in ('sending','failed'))
     or (old.status='sending' and new.status in ('accepted','failed','uncertain')))) then
  raise exception 'OPERATOR_NOTIFICATIONS_IMMUTABLE';
 end if;
 return new;
end $$;
create trigger peragus_operator_notifications_guard before update or delete on peragus_operator_notifications
 for each row execute function peragus_operator_notifications_guard();

create function peragus_daily_reviews_append_only() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin raise exception 'DAILY_REVIEWS_APPEND_ONLY'; end $$;
create trigger peragus_daily_reviews_immutable before update or delete on peragus_daily_reviews
 for each row execute function peragus_daily_reviews_append_only();

-- Enqueues one row per recipient role; idempotent per (environment, dedupe_key, recipient).
-- Returns the number of rows inserted (0 when already enqueued).
create function peragus_enqueue_operator_notification(p_environment text,p_kind text,p_severity text,p_dedupe_key text,
 p_purchase_id uuid,p_payload jsonb) returns integer language plpgsql
 set search_path = pg_catalog, public as $$
declare body jsonb; n integer;
begin
 body := coalesce(p_payload,'{}'::jsonb) || jsonb_build_object('kind',p_kind,'severity',p_severity,'environment',p_environment,
  'purchase_id',p_purchase_id);
 insert into public.peragus_operator_notifications(id,environment,kind,severity,recipient,dedupe_key,purchase_id,payload,payload_hash,idempotency_key)
 select s.id,p_environment,p_kind,p_severity,s.recipient,p_dedupe_key,p_purchase_id,body,
  encode(sha256(convert_to(body::text,'UTF8')),'hex'),'peragus-operator-notification-'||p_environment||'/'||s.id::text
 from (select gen_random_uuid() as id,r as recipient from unnest(array['operator','trusted']) r) s
 on conflict (environment,dedupe_key,recipient) do nothing;
 get diagnostics n = row_count;
 return n;
end $$;

-- Operation facts carried by every operation e-mail: status and the locked amounts.
create function peragus_operator_notification_purchase(p_purchase_id uuid) returns jsonb language sql stable
 set search_path = pg_catalog, public as $$
 select coalesce((select jsonb_build_object('status',p.status,'source_amount_brl',p.source_amount_brl::text,
   'locked_usdt_amount',coalesce(p.locked_usdt_amount,p.estimated_target_amount_usdt)::text)
  from public.peragus_customer_purchase_intents p where p.id=p_purchase_id),'{}'::jsonb)
$$;

-- Status transitions (every transition appends one status event in its own transaction).
-- Note events (from_status = to_status) are not transitions. 'refunded' is notified by
-- the refund completion itself (a completion may be recorded without the status move).
create function peragus_notify_operation_status_event() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
declare k text; sev text; key text;
begin
 if new.from_status is not distinct from new.to_status then return null; end if;
 k := case new.to_status when 'approved' then 'approval' when 'sending' then 'execution' when 'delivered_verified' then 'execution'
  when 'needs_review' then 'needs_review' when 'refund_pending' then 'refund_pending' end;
 if k is null then return null; end if;
 sev := case k when 'needs_review' then 'high' when 'refund_pending' then 'warn' else 'info' end;
 key := case when k='refund_pending'
  -- One refund_pending notice per refund episode, shared with the refund request insert.
  then 'refund_pending:'||new.purchase_id::text||':'||(select count(*) from public.peragus_operation_status_events e
   where e.purchase_id=new.purchase_id and e.to_status='refund_pending' and e.from_status is distinct from e.to_status)::text
  else 'status_event:'||new.id::text end;
 perform public.peragus_enqueue_operator_notification(new.environment,k,sev,key,new.purchase_id,
  public.peragus_operator_notification_purchase(new.purchase_id)||jsonb_build_object('from_status',new.from_status,'to_status',new.to_status,
   'reason_code',substring(new.reason from '^[A-Z][A-Z0-9_]{2,63}'),'event_at',new.created_at));
 return null;
end $$;
create trigger peragus_notify_operation_status_event after insert on peragus_operation_status_events
 for each row execute function peragus_notify_operation_status_event();

-- Refund requests, including the system ones recorded for a refund_pending operation (Ruling 21).
create function peragus_notify_refund_request() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 perform public.peragus_enqueue_operator_notification(new.environment,'refund_pending','warn',
  'refund_pending:'||new.purchase_intent_id::text||':'||(select count(*) from public.peragus_operation_status_events e
   where e.purchase_id=new.purchase_intent_id and e.to_status='refund_pending' and e.from_status is distinct from e.to_status)::text,
  new.purchase_intent_id,public.peragus_operator_notification_purchase(new.purchase_intent_id)||jsonb_build_object(
   'refund_request_id',new.id,'refund_amount_brl',new.amount_brl::text,'event_at',new.created_at));
 return null;
end $$;
create trigger peragus_notify_refund_request after insert on peragus_customer_refund_requests
 for each row execute function peragus_notify_refund_request();

-- Operator decision to refund an operation (048).
create function peragus_notify_operator_refund_decision() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 perform public.peragus_enqueue_operator_notification(new.environment,'operator_refund_decision','warn',
  'operator_refund_decision:'||new.id::text,new.purchase_id,public.peragus_operator_notification_purchase(new.purchase_id)||
  jsonb_build_object('decision','refund','from_status',new.from_status,'event_at',new.created_at));
 return null;
end $$;
create trigger peragus_notify_operator_refund_decision after insert on peragus_operator_refund_decisions
 for each row execute function peragus_notify_operator_refund_decision();

-- Approve/reject of a manual refund request (028; environment from the request).
create function peragus_notify_manual_refund_decision() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
declare r record;
begin
 select environment,purchase_intent_id,amount_brl into r from public.peragus_customer_refund_requests where id=new.refund_request_id;
 perform public.peragus_enqueue_operator_notification(r.environment,'operator_refund_decision','warn',
  'manual_refund_decision:'||new.id::text,r.purchase_intent_id,public.peragus_operator_notification_purchase(r.purchase_intent_id)||
  jsonb_build_object('decision',new.decision,'refund_request_id',new.refund_request_id,'refund_amount_brl',r.amount_brl::text,'event_at',new.created_at));
 return null;
end $$;
create trigger peragus_notify_manual_refund_decision after insert on peragus_manual_refund_decisions
 for each row execute function peragus_notify_manual_refund_decision();

-- Refund recorded as paid back (028).
create function peragus_notify_manual_refund_completion() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
declare r record;
begin
 select environment,purchase_intent_id into r from public.peragus_customer_refund_requests where id=new.refund_request_id;
 perform public.peragus_enqueue_operator_notification(r.environment,'refund_completed','info',
  'refund_completion:'||new.id::text,r.purchase_intent_id,public.peragus_operator_notification_purchase(r.purchase_intent_id)||
  jsonb_build_object('refund_request_id',new.refund_request_id,'refunded_amount_brl',new.amount_brl::text,'event_at',new.created_at));
 return null;
end $$;
create trigger peragus_notify_manual_refund_completion after insert on peragus_manual_refund_completions
 for each row execute function peragus_notify_manual_refund_completion();

-- Runtime kill switch changes (054). The operator's free-text reason stays in the audit.
create function peragus_notify_runtime_control_event() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 perform public.peragus_enqueue_operator_notification(new.environment,'runtime_control_changed',
  case when new.to_enabled then 'warn' else 'high' end,'runtime_control_event:'||new.id::text,null,
  jsonb_build_object('control_key',new.key,'from_enabled',new.from_enabled,'to_enabled',new.to_enabled,'event_at',new.created_at));
 return null;
end $$;
create trigger peragus_notify_runtime_control_event after insert on peragus_runtime_control_events
 for each row execute function peragus_notify_runtime_control_event();

do $$ declare f text; r text; begin
 foreach f in array array['peragus_operator_notifications_guard()','peragus_daily_reviews_append_only()',
  'peragus_enqueue_operator_notification(text,text,text,text,uuid,jsonb)','peragus_operator_notification_purchase(uuid)',
  'peragus_notify_operation_status_event()','peragus_notify_refund_request()','peragus_notify_operator_refund_decision()',
  'peragus_notify_manual_refund_decision()','peragus_notify_manual_refund_completion()','peragus_notify_runtime_control_event()'] loop
  execute format('revoke execute on function %s from public',f);
  for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
   execute format('revoke execute on function %s from %I',f,r);
  end loop;
 end loop;
end $$;
