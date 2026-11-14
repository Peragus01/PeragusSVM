-- Invitation e-mail idempotency keys name the row's money environment
-- ('peragus-invitation-test/<id>' in staging, 'peragus-invitation-live/<id>' in production).
-- Existing staging rows already satisfy the new check.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.peragus_invite_email_outbox'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%peragus-invitation-test/%'
  loop
    execute format('alter table public.peragus_invite_email_outbox drop constraint %I', c);
  end loop;
end $$;
alter table public.peragus_invite_email_outbox
  add constraint peragus_invite_email_outbox_idempotency_key_environment_check
  check (idempotency_key = 'peragus-invitation-' || environment || '/' || invite_id::text);
