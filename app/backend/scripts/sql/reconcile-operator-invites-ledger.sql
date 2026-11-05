-- Metadata-only adoption of an already applied staging migration.
-- Execute only on Supabase project lybdkqkbwlfwvmmvstzi.
-- Never runs the original ALTERs or resets the invitation sequence.
begin;
select pg_advisory_xact_lock(808613, 1);
do $reconcile$
declare expected constant text := '9e1a260d658e308626c6062015665542d7f6434ed0f2df384a43b7482b6a4e8e';
begin
  if not exists (
    select 1 from supabase_migrations.schema_migrations
    where version='20261101181204' and name='expand_operator_invites_037'
      and encode(sha256(convert_to(array_to_string(statements,E'\n'),'UTF8')),'hex')=expected
  ) then raise exception 'RECONCILIATION_SOURCE_MISMATCH'; end if;
  if to_regclass('public.peragus_pilot_invite_slot_sequence') is null
    or (select data_type from information_schema.columns where table_schema='public'
        and table_name='peragus_pilot_invite_slots' and column_name='slot') is distinct from 'integer'
    or (select data_type from information_schema.columns where table_schema='public'
        and table_name='peragus_pilot_invites' and column_name='slot') is distinct from 'integer'
    or exists(select 1 from pg_constraint where conrelid='public.peragus_pilot_invite_slots'::regclass
        and conname='peragus_pilot_invite_slots_slot_check')
    or not exists(select 1 from pg_constraint where conrelid='public.peragus_pilot_invites'::regclass
        and conname='peragus_pilot_invites_slot_fkey' and contype='f'
        and confrelid='public.peragus_pilot_invite_slots'::regclass)
  then raise exception 'RECONCILIATION_SCHEMA_MISMATCH'; end if;
  if exists(select 1 from public.peragus_schema_migrations
    where filename='037_expand_operator_invites.sql' and checksum<>expected)
  then raise exception 'RECONCILIATION_LEDGER_CONFLICT'; end if;
  insert into public.peragus_schema_migrations(filename,checksum)
  values('037_expand_operator_invites.sql',expected) on conflict(filename) do nothing;
end $reconcile$;
commit;
