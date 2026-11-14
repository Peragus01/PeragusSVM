-- FX rate lock deadline (facility.deadline_at on the transfer 201). It is a create-time
-- outcome that GET never returns, so it is stored here once, strictly parsed by the
-- service. Live Pix instructions are payable only before min(Pix expiry, lock deadline).
alter table peragus_customer_sandbox_pix
 add column lock_deadline_at timestamptz,
 add constraint peragus_pix_lock_deadline_check check(
  lock_deadline_at is null or (create_attempted and provider_transfer_id is not null)
 );

-- Recorded once: it can be set from null but never changed or cleared afterwards.
create function peragus_pix_lock_deadline_immutable() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 if old.lock_deadline_at is not null and new.lock_deadline_at is distinct from old.lock_deadline_at then
  raise exception 'PIX_LOCK_DEADLINE_IMMUTABLE';
 end if;
 return new;
end $$;
create trigger peragus_pix_lock_deadline_immutable before update on peragus_customer_sandbox_pix
 for each row execute function peragus_pix_lock_deadline_immutable();

do $$ declare r text; begin
 execute 'revoke execute on function peragus_pix_lock_deadline_immutable() from public';
 for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
  execute format('revoke execute on function peragus_pix_lock_deadline_immutable() from %I',r);
 end loop;
end $$;
