-- Audit metadata only: no old/new personal values or provider mutation.
create table peragus_customer_profile_audit (
 id bigint generated always as identity primary key,
 customer_id uuid not null references peragus_customers(id),actor_user_id uuid not null,
 changed_field text not null check(changed_field='display_name'),created_at timestamptz not null default now()
);
create function peragus_profile_audit_immutable() returns trigger language plpgsql as $$ begin raise exception 'profile audit is immutable'; end $$;
create trigger profile_audit_guard before update or delete on peragus_customer_profile_audit for each row execute function peragus_profile_audit_immutable();
alter table peragus_customer_profile_audit enable row level security;
revoke all on peragus_customer_profile_audit from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on peragus_customer_profile_audit from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on peragus_customer_profile_audit from authenticated; end if;
end $$;
