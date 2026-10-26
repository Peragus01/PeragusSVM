-- Administrative sandbox maintenance only; never removes customer/invite evidence.
create table peragus_sandbox_pilot_slot_releases (
 request_id uuid primary key,
 reason varchar(300) not null check(length(trim(reason)) between 10 and 300),
 database_actor text not null default current_user,
 released_slots jsonb not null check(jsonb_typeof(released_slots)='array' and jsonb_array_length(released_slots) between 1 and 5),
 created_at timestamptz not null default now(),
 environment text not null default 'test' check(environment='test')
);
create function peragus_guard_pilot_slot_release() returns trigger language plpgsql as $$
begin
 raise exception 'sandbox slot release audit is append only';
end $$;
create trigger peragus_pilot_slot_release_guard before update or delete on peragus_sandbox_pilot_slot_releases
 for each row execute function peragus_guard_pilot_slot_release();
alter table peragus_sandbox_pilot_slot_releases enable row level security;
revoke all on peragus_sandbox_pilot_slot_releases from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on peragus_sandbox_pilot_slot_releases from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on peragus_sandbox_pilot_slot_releases from authenticated; end if;
end $$;
