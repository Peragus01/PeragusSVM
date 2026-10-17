-- Sandbox-only fixture bindings. Never reuse this table for production identities.
create table peragus_ozav_sandbox_customer_links (
    customer_id uuid primary key references peragus_customers(id),
    environment text not null default 'test' check (environment = 'test'),
    idempotency_key text not null unique,
    request_hash char(64) not null check (request_hash ~ '^[0-9a-f]{64}$'),
    state text not null default 'pending' check (state in ('pending','linked')),
    ozav_customer_id text check (ozav_customer_id ~ '^ozav_cus_[A-Za-z0-9_]+$'),
    provider_status text,
    verification_mode text check (verification_mode in ('full','reliance')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(environment, ozav_customer_id),
    check ((state = 'pending' and ozav_customer_id is null)
        or (state = 'linked' and ozav_customer_id is not null))
);
alter table peragus_ozav_sandbox_customer_links enable row level security;
revoke all on peragus_ozav_sandbox_customer_links from public;
do $$ begin
    if exists(select 1 from pg_roles where rolname='anon') then
        execute 'revoke all on peragus_ozav_sandbox_customer_links from anon';
    end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then
        execute 'revoke all on peragus_ozav_sandbox_customer_links from authenticated';
    end if;
end $$;
