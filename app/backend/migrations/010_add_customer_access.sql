-- Identity originates exclusively from a server-verified Supabase Auth token.
-- No browser-facing policies: client access goes through the authenticated API.
create table peragus_customers (
    id uuid primary key,
    owner_user_id uuid not null unique,
    customer_type varchar(2) not null check (customer_type in ('pf', 'pj')),
    display_name varchar(160) not null check (length(trim(display_name)) >= 2),
    verification_status varchar(32) not null default 'draft'
        check (verification_status in ('draft', 'submitted', 'in_review', 'action_required', 'approved', 'rejected')),
    suspended boolean not null default false,
    created_at timestamptz not null default now()
);
alter table peragus_customers enable row level security;
revoke all on peragus_customers from public;
-- Explicitly revoke any Supabase default table grants, if those roles exist.
do $$ begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke all on peragus_customers from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'revoke all on peragus_customers from authenticated';
    end if;
end $$;

-- Legacy demo rows stay unowned and are inaccessible to authenticated customers.
alter table settlements add column customer_id uuid references peragus_customers(id);
create index settlements_customer_id_idx on settlements (customer_id, id);
-- Tenant-scoped creation/idempotency is deliberately deferred: operations are
-- closed in the authenticated runtime until per-customer payment routing exists.
