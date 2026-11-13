-- Runtime kill switches (Task 16). Not applied to any environment before this version.
--
-- The operator pauses, independently and at runtime: new operations (quote, purchase
-- accept, Pix create), USDT sends (withdrawal execution claim) and onboarding
-- (registration submission and verification start). Every guarded action reads its
-- switch `for share` in the same transaction as its claim/insert. A pause never
-- cancels or moves an operation; reconciliation, refunds and reads are never gated.
--
-- One row per (key, environment), seeded OFF for both environments (fail closed): the
-- operator turns the switches on. The rows are seeded before the 043 row-environment
-- guard is attached; afterwards only the row of the recorded database environment can
-- be changed, and a database without a recorded environment reads every switch as off.
create table peragus_runtime_controls (
 key text not null check(key in ('new_operations','usdt_sends','onboarding')),
 environment text not null constraint peragus_row_environment_check check(environment in ('test','live')),
 enabled boolean not null default false,
 updated_by uuid,
 updated_at timestamptz not null default now(),
 primary key(key,environment)
);
insert into peragus_runtime_controls(key,environment,enabled)
 select k,e,false from unnest(array['new_operations','usdt_sends','onboarding']) k cross join unnest(array['test','live']) e;

-- Append-only audit of every switch change.
create table peragus_runtime_control_events (
 id bigint generated always as identity primary key,
 key text not null check(key in ('new_operations','usdt_sends','onboarding')),
 from_enabled boolean not null,
 to_enabled boolean not null,
 operator_user_id uuid not null,
 reason text not null check(length(reason) between 1 and 500 and reason !~ '[[:cntrl:]]'),
 environment text not null constraint peragus_row_environment_check check(environment in ('test','live')),
 created_at timestamptz not null default now(),
 check(from_enabled<>to_enabled)
);
create index peragus_runtime_control_events_key on peragus_runtime_control_events(environment,key,id);

alter table peragus_runtime_controls enable row level security;
alter table peragus_runtime_control_events enable row level security;
revoke all on peragus_runtime_controls from public;
revoke all on peragus_runtime_control_events from public;
do $$ declare r text; begin
 for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
  execute format('revoke all on peragus_runtime_controls from %I',r);
  execute format('revoke all on peragus_runtime_control_events from %I',r);
 end loop;
end $$;

create trigger peragus_row_environment_guard before insert or update on peragus_runtime_controls
 for each row execute function peragus_enforce_row_environment();
create trigger peragus_row_environment_guard before insert or update on peragus_runtime_control_events
 for each row execute function peragus_enforce_row_environment();

-- A switch row is never removed (a missing row would read as paused, but loses its audit trail).
create function peragus_runtime_controls_undeletable() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin raise exception 'RUNTIME_CONTROLS_UNDELETABLE'; end $$;
create trigger peragus_runtime_controls_undeletable before delete on peragus_runtime_controls
 for each row execute function peragus_runtime_controls_undeletable();

create function peragus_runtime_control_events_append_only() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin raise exception 'RUNTIME_CONTROL_EVENTS_APPEND_ONLY'; end $$;
create trigger peragus_runtime_control_events_immutable before update or delete on peragus_runtime_control_events
 for each row execute function peragus_runtime_control_events_append_only();

do $$ declare f text; r text; begin
 foreach f in array array['peragus_runtime_controls_undeletable()','peragus_runtime_control_events_append_only()'] loop
  execute format('revoke execute on function %s from public',f);
  for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
   execute format('revoke execute on function %s from %I',f,r);
  end loop;
 end loop;
end $$;
