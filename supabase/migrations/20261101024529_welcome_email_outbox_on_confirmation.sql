-- Peragus welcome messages: staging only. No user data exposed through public schema.
create schema if not exists internal;
create table if not exists internal.welcome_email_outbox (
  user_id uuid primary key references auth.users(id) on delete cascade,
  recipient_email text not null,
  first_name text,
  state text not null default 'pending' check (state in ('pending','processing','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_id text,
  last_error text,
  created_at timestamptz not null default now()
);
revoke all on schema internal from public, anon, authenticated;
revoke all on internal.welcome_email_outbox from public, anon, authenticated;
create or replace function internal.enqueue_confirmed_welcome() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if NEW.email_confirmed_at is not null
     and OLD.email_confirmed_at is null
     and NEW.email is not null then
    insert into internal.welcome_email_outbox(user_id,recipient_email,first_name)
      values (NEW.id, NEW.email, left(coalesce(NEW.raw_user_meta_data->>'first_name', split_part(NEW.email,'@',1)),80))
      on conflict (user_id) do nothing;
  end if;
  return NEW;
end; $$;
revoke all on function internal.enqueue_confirmed_welcome() from public, anon, authenticated;
drop trigger if exists peragus_welcome_confirmed on auth.users;
create trigger peragus_welcome_confirmed after update of email_confirmed_at on auth.users
  for each row execute function internal.enqueue_confirmed_welcome();
-- The queue consumer runs independently of auth; failures do not prevent confirmation.
