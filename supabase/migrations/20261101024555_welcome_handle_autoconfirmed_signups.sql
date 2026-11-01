create or replace function internal.enqueue_confirmed_welcome() returns trigger
language plpgsql security definer set search_path = '' as $$
declare was_confirmed boolean;
begin
  was_confirmed := case when TG_OP = 'INSERT' then false else OLD.email_confirmed_at is not null end;
  if NEW.email_confirmed_at is not null and not was_confirmed and NEW.email is not null then
    insert into internal.welcome_email_outbox(user_id,recipient_email,first_name)
    values(NEW.id,NEW.email,left(coalesce(nullif(NEW.raw_user_meta_data->>'first_name',''),split_part(NEW.email,'@',1)),80))
    on conflict (user_id) do nothing;
  end if;
  return NEW;
end; $$;
drop trigger if exists peragus_welcome_confirmed on auth.users;
create trigger peragus_welcome_confirmed after insert or update of email_confirmed_at on auth.users
  for each row execute function internal.enqueue_confirmed_welcome();
