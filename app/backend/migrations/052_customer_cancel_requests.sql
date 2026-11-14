-- Customer cancel before Pix payment (refund policy 7.1, Task 13b). Not applied to
-- any environment before this version.
--
-- A customer may ask to cancel while the operation is accepted or awaiting_pix and
-- the Pix payment is not received. The request never closes an operation that has a
-- Pix transfer (OZAV has no transfer-cancel endpoint): it hides the instructions and
-- the operation expires as usual. A payment confirmed afterwards withdraws it
-- (cancel_withdrawn_at). An accepted operation without a Pix is expired at once.
-- No transition edge changes (accepted -> expired already exists).
alter table peragus_customer_purchase_intents
 add column cancel_requested_at timestamptz,
 add column cancel_request_id uuid,
 add column cancel_withdrawn_at timestamptz,
 add constraint peragus_purchase_cancel_request_check check(
  (cancel_requested_at is null) = (cancel_request_id is null)
  and (cancel_withdrawn_at is null or cancel_requested_at is not null)
 );
create unique index peragus_purchase_cancel_request_id on peragus_customer_purchase_intents(customer_id,cancel_request_id)
 where cancel_request_id is not null;

-- Recorded once: a cancel request is set only while the operation can still be
-- cancelled, and neither it nor its withdrawal can be changed or cleared afterwards.
create function peragus_purchase_cancel_guard() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 if tg_op='INSERT' then
  if new.cancel_requested_at is not null or new.cancel_request_id is not null or new.cancel_withdrawn_at is not null then
   raise exception 'PURCHASE_CANCEL_INVALID';
  end if;
  return new;
 end if;
 if old.cancel_requested_at is not null and (new.cancel_requested_at is distinct from old.cancel_requested_at
   or new.cancel_request_id is distinct from old.cancel_request_id) then
  raise exception 'PURCHASE_CANCEL_IMMUTABLE';
 end if;
 if old.cancel_withdrawn_at is not null and new.cancel_withdrawn_at is distinct from old.cancel_withdrawn_at then
  raise exception 'PURCHASE_CANCEL_IMMUTABLE';
 end if;
 if old.cancel_requested_at is null and new.cancel_requested_at is not null
   and old.status not in ('accepted','awaiting_pix') then
  raise exception 'PURCHASE_CANCEL_INVALID';
 end if;
 return new;
end $$;
create trigger peragus_purchase_cancel_guard before insert or update on peragus_customer_purchase_intents
 for each row execute function peragus_purchase_cancel_guard();

do $$ declare r text; begin
 execute 'revoke execute on function peragus_purchase_cancel_guard() from public';
 for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
  execute format('revoke execute on function peragus_purchase_cancel_guard() from %I',r);
 end loop;
end $$;
